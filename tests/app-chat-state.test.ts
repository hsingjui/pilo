import assert from "node:assert/strict";
import test from "node:test";

import { createChatUiStateCache } from "../src/components/app/chat-ui-state-cache.ts";
import {
	MAX_OPEN_CHAT_CONTROLLERS,
	MAX_OPEN_CHAT_ESTIMATED_HISTORY_BYTES,
	chatUiStateKey,
	identifyOpenedChat,
	mergeSidebarSessionsWithOpenChats,
	syncOpenedChatSessionMetadata,
	toSidebarSession,
	touchOpenedChat,
	trimOpenedChats,
	upsertOpenedChat,
	type OpenChat,
} from "../src/components/app/app-chat-state.ts";
import type { ChatSession } from "../src/components/chat/chat-page-utils.ts";
import {
	routeInitialDeferredSubmissions,
	shouldDeferSubmissionUntilHistoryReady,
} from "../src/components/chat/chat-submission-state.ts";
import type { Project } from "../src/lib/projects.ts";
import type { SessionIndexEntry } from "../src/lib/sessions.ts";

const project: Project = {
	id: "project:local:/project",
	name: "project",
	path: "/project",
	connection: { id: "local", name: "Local", kind: { type: "local" } },
	metadata: {
		cwd: "/project",
		gitBranch: "main",
		piVersion: "1.0.0",
		refreshedAtMs: 1,
	},
	createdAtMs: 1,
	lastOpenedAtMs: 1,
};

function chat(id: string, historyFileSize?: number): ChatSession {
	return { id, title: id, projectRecord: project, historyFileSize };
}

function opened(count: number) {
	let result: OpenChat[] = [];
	for (let index = 0; index < count; index += 1) {
		result = upsertOpenedChat(result, chat(`chat-${index}`));
	}
	return result;
}

function indexedSession(
	id: string,
	fileSize: number,
	fileMtimeNs = "123",
): SessionIndexEntry {
	return {
		connectionId: "local",
		projectId: project.id,
		piSessionId: id,
		sessionPath: `/sessions/${id}.jsonl`,
		name: id,
		cwd: project.path,
		createdAt: "2026-09-13T00:00:00Z",
		updatedAt: "2026-09-13T00:00:00Z",
		messageCount: 1,
		lastMessageAt: null,
		firstUserMessagePreview: null,
		fileSize,
		fileMtimeNs,
		lastOffset: 0,
		indexedAtMs: 1,
		pinned: false,
		titleOverride: null,
	};
}

test("touching an opened chat moves it to the most-recent position", () => {
	const initial = opened(4);
	const controllerId = initial[1].controllerId;
	const touched = touchOpenedChat(initial, chat("chat-1"));

	assert.equal(touched.length, 4);
	assert.equal(touched.at(-1)?.session.id, "chat-1");
	assert.equal(touched.at(-1)?.controllerId, controllerId);
	assert.deepEqual(
		touched.map((entry) => entry.session.id),
		["chat-0", "chat-2", "chat-3", "chat-1"],
	);
});

test("opened chat controllers are trimmed from the oldest idle entries", () => {
	const initial = opened(MAX_OPEN_CHAT_CONTROLLERS + 3);
	const trimmed = trimOpenedChats(initial, new Set());

	assert.equal(trimmed.length, MAX_OPEN_CHAT_CONTROLLERS);
	assert.deepEqual(
		trimmed.map((entry) => entry.session.id),
		initial.slice(3).map((entry) => entry.session.id),
	);
});

test("small history chats can stay resident beyond the old eight-controller cap", () => {
	const initial = opened(10);
	const trimmed = trimOpenedChats(initial, new Set());

	assert.equal(trimmed.length, 10);
});

test("history memory budget evicts the oldest idle controllers first", () => {
	let initial: OpenChat[] = [];
	for (const [id, size] of [
		["old-large", 24 * 1024 * 1024],
		["middle", 12 * 1024 * 1024],
		["newest", 4 * 1024 * 1024],
	] as const) {
		initial = upsertOpenedChat(initial, chat(id, size));
	}
	const trimmed = trimOpenedChats(
		initial,
		new Set(),
		MAX_OPEN_CHAT_CONTROLLERS,
		MAX_OPEN_CHAT_ESTIMATED_HISTORY_BYTES,
	);

	assert.deepEqual(
		trimmed.map((entry) => entry.session.id),
		["middle", "newest"],
	);
});

test("latest indexed file sizes are synchronized before memory trimming", () => {
	let initial: OpenChat[] = [];
	initial = upsertOpenedChat(initial, chat("old", 1));
	initial = upsertOpenedChat(initial, chat("new", 1));
	const synchronized = syncOpenedChatSessionMetadata(initial, [
		indexedSession("old", 40 * 1024 * 1024),
		indexedSession("new", 4 * 1024 * 1024),
	]);
	const trimmed = trimOpenedChats(synchronized, new Set());

	assert.equal(synchronized[0].session.historyFileSize, 40 * 1024 * 1024);
	assert.deepEqual(
		trimmed.map((entry) => entry.session.id),
		["new"],
	);
});

test("identified draft receives indexed history metadata without changing controller identity", () => {
	const draft = upsertOpenedChat([], chat("draft-1"));
	const controllerId = draft[0].controllerId;
	const identified = identifyOpenedChat(draft, controllerId, "pi-1");
	const synchronized = syncOpenedChatSessionMetadata(identified, [
		indexedSession("pi-1", 8 * 1024 * 1024, "456"),
	]);

	assert.equal(synchronized[0].controllerId, controllerId);
	assert.equal(synchronized[0].session.id, "draft-1");
	assert.equal(synchronized[0].piSessionId, "pi-1");
	assert.equal(synchronized[0].session.sessionPath, undefined);
	assert.equal(synchronized[0].session.historyFileSize, 8 * 1024 * 1024);
	assert.equal(synchronized[0].session.historyFileMtimeNs, "456");
});

test("busy chat controllers are protected while idle controllers are evicted", () => {
	const initial = opened(MAX_OPEN_CHAT_CONTROLLERS + 2);
	const protectedController = initial[0].controllerId;
	const trimmed = trimOpenedChats(initial, new Set([protectedController]));

	assert.equal(trimmed.length, MAX_OPEN_CHAT_CONTROLLERS);
	assert.equal(trimmed[0].controllerId, protectedController);
	assert(!trimmed.some((entry) => entry.session.id === "chat-1"));
	assert(!trimmed.some((entry) => entry.session.id === "chat-2"));
	assert.equal(trimmed.at(-1)?.session.id, `chat-${initial.length - 1}`);
});

test("draft controller identity survives rekeying to a discovered Pi session", () => {
	const draft = upsertOpenedChat([], chat("draft-1"));
	const controllerId = draft[0].controllerId;
	const identified = identifyOpenedChat(draft, controllerId, "pi-1");
	const refreshed = upsertOpenedChat(identified, {
		...chat("pi-1"),
		sessionPath: "/sessions/pi-1.jsonl",
	});

	assert.equal(refreshed.length, 1);
	assert.equal(refreshed[0].controllerId, controllerId);
	assert.equal(refreshed[0].uiStateKey, chatUiStateKey(project.id, "pi-1"));
	assert.equal(refreshed[0].session.id, "draft-1");
	assert.equal(refreshed[0].session.sessionPath, undefined);
	assert.equal(refreshed[0].piSessionId, "pi-1");
});

test("newly opened draft appears in the sidebar before it is indexed", () => {
	const draft = upsertOpenedChat([], chat("draft-1"), "first prompt");
	const controllerId = draft[0].controllerId;
	const now = new Date("2026-09-13T06:00:00Z");
	const sidebar = mergeSidebarSessionsWithOpenChats(
		[],
		draft,
		new Set([controllerId]),
		now,
	);

	assert.equal(sidebar.length, 1);
	assert.equal(sidebar[0].id, "draft-1");
	assert.equal(sidebar[0].preview, "first prompt");
	assert.equal(sidebar[0].active, true);
	assert.equal(sidebar[0].latestMessageAt, now);
});

test("identified open chat merges with its indexed sidebar session and keeps activity", () => {
	const draft = upsertOpenedChat([], chat("draft-1"), "first prompt");
	const identified = identifyOpenedChat(draft, draft[0].controllerId, "pi-1");
	const indexed = toSidebarSession(indexedSession("pi-1", 1024));
	const sidebar = mergeSidebarSessionsWithOpenChats(
		[indexed],
		identified,
		new Set([draft[0].controllerId]),
	);

	assert.equal(sidebar.length, 1);
	assert.equal(sidebar[0].id, "pi-1");
	assert.equal(sidebar[0].active, true);
});

test("inactive indexed sidebar sessions preserve object identity", () => {
	const entry = indexedSession("pi-1", 1024);
	const indexed = toSidebarSession(entry);
	const cached = toSidebarSession(entry);
	const sidebar = mergeSidebarSessionsWithOpenChats([indexed], [], new Set());

	assert.equal(cached, indexed);
	assert.equal(sidebar[0], indexed);
});

test("sidebar activity stays isolated across concurrently opened chats", () => {
	let chats = upsertOpenedChat([], chat("chat-a"));
	chats = upsertOpenedChat(chats, chat("chat-b"));
	const sidebar = mergeSidebarSessionsWithOpenChats(
		[],
		chats,
		new Set([chats[0].controllerId]),
	);

	assert.equal(
		sidebar.find((session) => session.id === "chat-a")?.active,
		true,
	);
	assert.equal(
		sidebar.find((session) => session.id === "chat-b")?.active,
		false,
	);
});

test("chat UI state cache preserves draft and scroll state across session rekey", () => {
	const cache = createChatUiStateCache();
	const draftKey = chatUiStateKey(project.id, "draft-1");
	const sessionKey = chatUiStateKey(project.id, "pi-1");
	cache.patch(draftKey, {
		draft: "unsent draft",
		scrollTop: 480,
		sticky: false,
		deferredSubmissions: ["queued while loading"],
	});

	cache.rekey(draftKey, sessionKey);

	assert.deepEqual(cache.get(sessionKey), {
		draft: "unsent draft",
		scrollTop: 480,
		sticky: false,
		deferredSubmissions: ["queued while loading"],
	});
	assert.equal(cache.size(), 1);
});

test("chat UI state cache stays bounded and uses LRU eviction", () => {
	const cache = createChatUiStateCache(2);
	cache.patch("a", { draft: "a" });
	cache.patch("b", { draft: "b" });
	cache.get("a");
	cache.patch("c", { draft: "c" });

	assert.equal(cache.size(), 2);
	assert.equal(cache.get("a").draft, "a");
	assert.equal(cache.get("b").draft, "");
	assert.equal(cache.get("c").draft, "c");
});

test("fallback submissions for existing sessions wait for history", () => {
	assert.deepEqual(
		routeInitialDeferredSubmissions("/sessions/existing.jsonl", ["one", "two"]),
		{ runtime: [], history: ["one", "two"] },
	);
	assert.equal(
		shouldDeferSubmissionUntilHistoryReady(
			"/sessions/existing.jsonl",
			"loading",
		),
		true,
	);
	assert.equal(
		shouldDeferSubmissionUntilHistoryReady("/sessions/existing.jsonl", "error"),
		true,
	);
	assert.equal(
		shouldDeferSubmissionUntilHistoryReady("/sessions/existing.jsonl", "ready"),
		false,
	);
});

test("fallback submissions for new sessions can go directly to runtime", () => {
	assert.deepEqual(routeInitialDeferredSubmissions(undefined, ["one", "two"]), {
		runtime: ["one", "two"],
		history: [],
	});
	assert.equal(
		shouldDeferSubmissionUntilHistoryReady(undefined, "loading"),
		false,
	);
});
