import { mount, Storage } from "nsh";

import type { ConversationEvent } from "@shared/chat/conversation-types";
import type { Connection } from "@shared/api/pi-runtime-types";
import type { Project } from "@shared/api/projects-types";
import type { SessionIndexEntry } from "@shared/api/sessions-types";
import type { ThemeSettings } from "@shared/theme-settings-types";
import "../shell/fonts";
import { AppShell } from "../shell/AppShell";
import { conversationContext, followOpenSession } from "../shell/open-chat";
import { initializeI18n } from "../shell/i18n";
import { AppStore } from "../state/app-store";
import { ComposerStore } from "../composer/composer-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { composerStubClient } from "./composer-fixture";
import { fixtureThemeFamily } from "./fixture-theme";
import { scriptedClient } from "./scripted-app-client";

/**
 * The shell over a scripted client with projects on two connections:
 * `pilo` has seven saved sessions (one running a turn, one unread), `notes`
 * has none, `broken` fails to list its sessions, `slow` never answers and
 * `api`, on a remote machine, has the latest session of all. Of `pilo`'s
 * sessions, `s4` has two settled turns, `s7` has one that cannot be read at
 * first, and the others have no message.
 */
const local: Connection = {
	id: "local",
	name: "Local",
	kind: { type: "local" },
};
const remote = { id: "c-build", name: "build-box", kind: { type: "ssh" } };

function project(id: string, connection: object): Project {
	return {
		id,
		name: id,
		path: `/code/${id}`,
		connection: connection as Connection,
	} as Project;
}

/** A session of `pilo` whose last message came `day` days into November. */
function session(day: number, title: string | null): SessionIndexEntry {
	const at = `2026-11-${String(day).padStart(2, "0")}T09:00:00Z`;
	return {
		connectionId: local.id,
		projectId: "pilo",
		piSessionId: `s${day}`,
		sessionPath: `/sessions/s${day}.jsonl`,
		name: null,
		cwd: "/code/pilo",
		createdAt: at,
		updatedAt: at,
		messageCount: 2,
		lastMessageAt: at,
		firstUserMessagePreview: title,
		fileSize: 1,
		fileMtimeNs: "0",
		lastOffset: 1,
		indexedAtMs: 0,
		pinned: false,
		titleOverride: null,
	};
}

// Expanding `notes` reads its sessions twice, both empty; every read
// after answers with its session, so a refresh has something new to show.
let notesReads = 0;
const sessions: Record<string, () => Promise<SessionIndexEntry[]>> = {
	pilo: () =>
		Promise.resolve([
			session(1, "Port the settings page"),
			{ ...session(2, "Fix the flaky dialog test"), name: "Dialog test" },
			session(3, "Read the session index"),
			session(4, "Resize the sidebar"),
			session(5, "Wire the transcript store"),
			session(6, null),
			{ ...session(7, "Sketch the composer"), titleOverride: "Composer" },
		]),
	api: () =>
		Promise.resolve([
			{
				...session(8, "Deploy the build box"),
				connectionId: remote.id,
				projectId: "api",
				cwd: "/code/api",
			},
		]),
	notes: () =>
		Promise.resolve(
			notesReads++ < 2
				? []
				: [
						{
							...session(9, "Sketch the notes app"),
							projectId: "notes",
							piSessionId: "n1",
							sessionPath: "/sessions/n1.jsonl",
						},
					],
		),
	broken: () => Promise.reject(new Error("The session index is locked.")),
	slow: () => new Promise(() => {}),
};

/** A settled turn: a prompt and its reply. */
function turn(minute: number, prompt: string, reply: string) {
	const timestampMs = Date.UTC(2026, 10, 4, 9, minute);
	return [
		{ type: "user_message_start", text: prompt, timestampMs },
		{ type: "assistant_message_start", timestampMs },
		{ type: "assistant_text_delta", delta: reply, timestampMs },
		{ type: "assistant_turn_end", stopReason: "stop", timestampMs },
	] as ConversationEvent[];
}

let unreadable = true;
const histories: Record<string, () => Promise<ConversationEvent[]>> = {
	"/sessions/s4.jsonl": () =>
		Promise.resolve([
			...turn(0, "Resize the sidebar", "The sidebar now takes a width."),
			...turn(1, "Keep it between launches", "The width is stored."),
		]),
	"/sessions/s7.jsonl": () => {
		if (unreadable) {
			unreadable = false;
			return Promise.reject(new Error("The session file is locked."));
		}
		return Promise.resolve(
			turn(0, "Sketch the composer", "A text field and a send button."),
		);
	},
};

async function run() {
	const themeSettings = {
		revision: 1,
		theme: "system",
		themeFamily: await fixtureThemeFamily(),
	} as ThemeSettings;
	/** `pilo`'s index entries, for `updateSessionUiState` to answer with. */
	const piloIndex = await sessions.pilo();
	/** The calls the app made on the client, for the test to read via storage. */
	const clientCalls: Record<string, unknown>[] = [];
	const record = (call: Record<string, unknown>) => {
		clientCalls.push(call);
		void Storage.setItem("pilo.test.clientCalls", JSON.stringify(clientCalls));
	};
	const runtime = scriptedClient({
		projects: [
			project("api", remote),
			project("pilo", local),
			project("notes", local),
			project("broken", local),
			project("slow", local),
		],
		themeSettings,
		sessions: (projectId) => {
			record({ call: "listSessions", projectId });
			return sessions[projectId]?.() ?? Promise.resolve([]);
		},
		onUpdateSessionUiState(sessionPath, update, projectId) {
			record({ call: "updateSessionUiState", sessionPath, update, projectId });
			const entry = piloIndex.find(
				(known) => known.sessionPath === sessionPath,
			);
			runtime.emit({
				type: "sessions_indexed",
				projectId: projectId ?? "pilo",
			});
			return { ...entry, ...update } as SessionIndexEntry;
		},
		onDeleteSession(projectId, sessionPath) {
			record({ call: "deleteSession", projectId, sessionPath });
			runtime.emit({ type: "sessions_indexed", projectId });
			return { method: "trash" as const };
		},
		history: (sessionPath) => histories[sessionPath]?.() ?? Promise.resolve([]),
		chatSessions: [
			{
				sessionKey: "running",
				projectId: "pilo",
				sessionPath: "/sessions/s1.jsonl",
				prepared: true,
				initialized: true,
				activeTurn: true,
				snapshot: {
					generation: 1,
					state: "running",
					connection: local,
					projectId: "pilo",
				},
			},
		],
		readStates: [
			{
				projectId: "pilo",
				sessionPath: "/sessions/s5.jsonl",
				completedRevision: 2,
				readRevision: 1,
			},
		],
	});
	const chat = new ChatTranscriptStore(runtime.client, conversationContext());
	const store = new AppStore(runtime.client, chat);
	const composer = new ComposerStore({
		client: composerStubClient(runtime.client),
		app: store.state,
	});
	followOpenSession(store, chat);
	mount(AppShell, { store, chat, composer, projectClient: runtime.client });
	await store.start();
}

initializeI18n();
void run();
