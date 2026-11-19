import { expect, open, test } from "nsh/test";

import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-types";
import type {
	PiloClientEvent,
	PiloClientEventOptions,
	PiloClientHistoryOptions,
} from "@/lib/api/pilo-client";
import type {
	SessionHistoryMessageIndexEntry,
	SessionHistoryResult,
} from "@/lib/api/sessions-types";
import type { ConversationReducerContext } from "@/lib/chat/conversation-types";
import type {
	ChatTranscriptSnapshot,
	ChatTranscriptWindow,
	NshPiloClientBootstrap,
} from "../client/nsh-pilo-client";
import { AppStore, type AppStoreClient } from "../state/app-store";
import {
	type ChatTranscriptClient,
	ChatTranscriptStore,
} from "../state/chat-transcript-store";

const chat = { sessionKey: "k1", projectId: "p1", generation: 1 };
const target = { sessionKey: "k1", projectId: "p1", sessionPath: "/s.jsonl" };

function context(): ConversationReducerContext {
	let id = 0;
	return {
		createMessageId: (kind) => `${kind}-${++id}`,
		createContentId: (kind) => `${kind}-${++id}`,
		now: () => 0,
		formatTime: () => "00:00",
	};
}

const runtime = (
	state: string,
	generation = chat.generation,
	rest: Partial<ChatSessionRuntimeState> = {},
) =>
	({
		activeTurn: false,
		...rest,
		snapshot: { state, generation },
	}) as ChatSessionRuntimeState;
const running = runtime("running");
/** A Pi that is running a turn, as a truncated snapshot's chat usually is. */
const busy = runtime("running", chat.generation, { activeTurn: true });
const stopped = runtime("stopped");
/** A session file's settled history: one question per text. */
const history = (...questions: string[]) =>
	({
		history: {
			events: questions.map((text) => ({ type: "user_message_start", text })),
		},
		fingerprint: null,
	}) as unknown as SessionHistoryResult;
const asked = (sequence: number, text: string): PiloClientEvent => ({
	...chat,
	type: "user_message_start",
	text,
	sequence,
});
const replying = (sequence: number): PiloClientEvent => ({
	...chat,
	type: "assistant_message_start",
	sequence,
});
const process = (
	sequence: number,
	state: string,
	generation = chat.generation,
) =>
	({
		...chat,
		generation,
		type: "process_state",
		state,
		sequence,
	}) as PiloClientEvent;

/** A snapshot whose saved history is one question. */
const snapshot = (
	eventSequence: number,
	live: ChatTranscriptSnapshot["live"] = { type: "idle" },
	generation = chat.generation,
): ChatTranscriptSnapshot => ({
	eventSequence,
	sessionKey: chat.sessionKey,
	generation,
	history: {
		history: {
			events:
				live.type === "truncated"
					? []
					: [{ type: "user_message_start", text: "saved" }],
		} as ChatTranscriptSnapshot["history"]["history"],
		fingerprint: null,
	},
	live,
});
/** The start of a turn, as the events of an active snapshot. */
const turn = (text: string): ChatTranscriptSnapshot["live"] => ({
	type: "active",
	events: [
		{ ...chat, type: "user_message_start", text: "asked" },
		{ ...chat, type: "assistant_message_start" },
		{ ...chat, type: "assistant_text_delta", delta: text },
	],
});
const delta = (
	sequence: number,
	text: string,
	from: Partial<typeof chat> = {},
): PiloClientEvent => ({
	...chat,
	...from,
	type: "assistant_text_delta",
	delta: text,
	sequence,
});
const settled = (sequence: number): PiloClientEvent => ({
	...chat,
	type: "assistant_message_end",
	stopReason: "stop",
	errorMessage: null,
	usage: null,
	sequence,
});

/** What every read asks for, as the WebUI's first read of a session does. */
const firstWindow = { messageLimit: 80, includeMessageIndex: true };

/** The index entry of a saved message; even ones are the user's. */
const entry = (at: number): SessionHistoryMessageIndexEntry => ({
	id: `entry-${at}`,
	role: at % 2 === 0 ? "user" : "assistant",
	preview: `preview ${at}`,
	estimatedChars: 100 + at,
});
/**
 * A window of a session of `total` messages that starts at `start`: its
 * questions and replies, with the session's whole message index. The
 * file's fingerprint is its number of messages.
 */
const windowed = (total: number, start: number, limit = total - start) =>
	({
		history: {
			events: Array.from({ length: limit }, (_, offset) =>
				(start + offset) % 2 === 0
					? { type: "user_message_start", text: `question ${start + offset}` }
					: [
							{ type: "assistant_message_start" },
							{
								type: "assistant_text_delta",
								delta: `reply ${start + offset}`,
							},
							{ type: "assistant_turn_end", stopReason: "stop" },
						],
			).flat(),
			messageIndex: Array.from({ length: total }, (_, at) => entry(at)),
			windowStartMessage: start,
			totalMessages: total,
		},
		fingerprint: { fileSize: total, fileMtimeNs: "1" },
	}) as unknown as SessionHistoryResult;

type Reply<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

/**
 * A client whose snapshot calls the test answers one at a time. A history
 * read answers `answers.history` at once, or waits for the test when that
 * is `null`.
 */
function fakeClient() {
	const snapshots: (Reply<ChatTranscriptSnapshot> & {
		window?: ChatTranscriptWindow;
	})[] = [];
	const histories: (Reply<SessionHistoryResult> & {
		projectId: string;
		sessionPath: string;
		options?: PiloClientHistoryOptions;
	})[] = [];
	const answers = {
		runtime: running as ChatSessionRuntimeState | null,
		history: history("settled") as SessionHistoryResult | null,
		/**
		 * The session whose pages a read with a start message answers at
		 * once, as its number of messages; such a read waits when `null`.
		 */
		pages: null as number | null,
		/** How many times the runtime state was read. */
		reads: 0,
	};
	const client: ChatTranscriptClient = {
		chatState() {
			answers.reads += 1;
			return Promise.resolve(answers.runtime);
		},
		chatTranscriptSnapshot: (_sessionKey, window) =>
			new Promise((resolve, reject) =>
				snapshots.push({ window, resolve, reject }),
			),
		loadHistory: (projectId, sessionPath, options) =>
			new Promise((resolve, reject) => {
				histories.push({ projectId, sessionPath, options, resolve, reject });
				if (options?.startMessage === undefined) {
					if (answers.history) resolve(answers.history);
				} else if (answers.pages !== null) {
					resolve(
						windowed(answers.pages, options.startMessage, options.messageLimit),
					);
				}
			}),
	};
	const store = new ChatTranscriptStore(client, context());
	const texts = () =>
		store.state().conversation?.messages.map((message) => message.text);
	/** The page reads so far, as their first message and length. */
	const pages = () =>
		histories
			.filter(({ options }) => options?.startMessage !== undefined)
			.map(({ options }) => [options?.startMessage, options?.messageLimit]);
	return { store, snapshots, histories, answers, texts, pages };
}

/** Lets the calls already answered run to their next wait. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("a chat opens as loading and shows its snapshot", async () => {
	const { store, snapshots, texts } = fakeClient();
	expect(store.state().status).toBe("closed");

	const opened = store.open(target, true);
	expect(store.state()).toEqual({
		sessionKey: "k1",
		status: "loading",
		conversation: null,
		historyPrefix: [],
		source: null,
	});
	await settle();
	snapshots[0]?.resolve(snapshot(10));
	await opened;

	expect(store.state().status).toBe("ready");
	expect(texts()).toEqual(["saved"]);
});

test("events that arrive while the snapshot is awaited are applied above its cut only", async () => {
	const { store, snapshots, texts } = fakeClient();
	const opened = store.open(target, true);
	await settle();
	store.receive([delta(9, " stale"), delta(10, " at the cut")]);
	store.receive([delta(11, " two"), delta(12, " other", { sessionKey: "k2" })]);
	// Nothing is shown from the events alone.
	expect(store.state().conversation).toBe(null);

	snapshots[0]?.resolve(snapshot(10, turn("one")));
	await opened;

	expect(texts()).toEqual(["saved", "asked", "one two"]);
});

test("a ready chat follows its later events and ignores other chats", async () => {
	const { store, snapshots, texts } = fakeClient();
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10, turn("one")));
	await opened;

	store.receive([delta(10, " again"), delta(11, " two")]);
	store.receive([
		delta(12, " other", { sessionKey: "k2" }),
		{ type: "configuration_changed", sequence: 13 },
		delta(14, " three"),
	]);

	expect(texts()).toEqual(["saved", "asked", "one two three"]);
	const before = store.state();
	store.receive([delta(15, " other", { sessionKey: "k2" })]);
	expect(store.state()).toBe(before);
});

test("after lost events the chat is read again and keeps what it showed meanwhile", async () => {
	const { store, snapshots, texts } = fakeClient();
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10, turn("one")));
	await opened;

	const refreshed = store.refresh();
	expect(store.state().status).toBe("loading");
	expect(texts()).toEqual(["saved", "asked", "one"]);
	await settle();
	// Events of the old snapshot's stream are not applied to it any more.
	store.receive([delta(31, " late")]);
	expect(texts()).toEqual(["saved", "asked", "one"]);
	snapshots[1]?.resolve(snapshot(30, turn("one two")));
	await refreshed;

	expect(snapshots.length).toBe(2);
	expect(store.state().status).toBe("ready");
	expect(texts()).toEqual(["saved", "asked", "one two late"]);
});

test("an event of a newer Pi process takes a fresh snapshot", async () => {
	const { store, snapshots, texts } = fakeClient();
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10, turn("one")));
	await opened;

	store.receive([delta(11, " two"), delta(12, "new", { generation: 2 })]);
	// What the old process sent before the restart is still shown.
	expect(texts()).toEqual(["saved", "asked", "one two"]);
	expect(store.state().status).toBe("loading");
	await settle();
	snapshots[1]?.resolve(snapshot(12, { type: "idle" }, 2));
	await settle();

	expect(snapshots.length).toBe(2);
	expect(store.state().status).toBe("ready");
	expect(texts()).toEqual(["saved"]);
	// A late event of the old process is neither shown nor a reason to read.
	store.receive([delta(13, " old", { generation: 1 })]);
	await settle();
	expect(snapshots.length).toBe(2);
	expect(store.state().status).toBe("ready");
	expect(texts()).toEqual(["saved"]);
});

test("a newer Pi process seen while the snapshot was awaited takes another", async () => {
	const { store, snapshots } = fakeClient();
	const opened = store.open(target, true);
	await settle();
	store.receive([delta(11, "new", { generation: 2 })]);
	snapshots[0]?.resolve(snapshot(10));
	await opened;
	await settle();

	expect(snapshots.length).toBe(2);
	expect(store.state().status).toBe("loading");
	snapshots[1]?.resolve(snapshot(11, { type: "idle" }, 2));
	await settle();
	expect(store.state().status).toBe("ready");
	expect(snapshots.length).toBe(2);
});

test("a truncated snapshot shows nothing new and is taken again once when the turn settles", async () => {
	const { store, snapshots, histories, answers, texts } = fakeClient();
	answers.runtime = busy;
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10, { type: "truncated" }));
	await opened;

	// Its empty history is not the chat's, so the chat is still loading.
	expect(store.state()).toEqual({
		sessionKey: "k1",
		status: "loading",
		conversation: null,
		historyPrefix: [],
		source: null,
	});
	// The running turn's events are not applied, and ask for nothing.
	store.receive([delta(11, "partial"), delta(12, " reply")]);
	await settle();
	expect(snapshots.length).toBe(1);
	expect(histories.length).toBe(0);
	expect(store.state().conversation).toBe(null);

	store.receive([settled(13)]);
	await settle();
	expect(snapshots.length).toBe(2);
	snapshots[1]?.resolve(snapshot(13));
	await settle();

	expect(store.state().status).toBe("ready");
	expect(store.state().source).toBe("snapshot");
	expect(texts()).toEqual(["saved"]);
	expect(histories.length).toBe(0);
});

test("a truncated snapshot keeps the transcript the chat showed before", async () => {
	const { store, snapshots, answers, texts } = fakeClient();
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10, turn("one")));
	await opened;

	answers.runtime = busy;
	const refreshed = store.refresh();
	await settle();
	snapshots[1]?.resolve(snapshot(20, { type: "truncated" }));
	await refreshed;

	expect(store.state().status).toBe("loading");
	expect(store.state().source).toBe("snapshot");
	expect(texts()).toEqual(["saved", "asked", "one"]);
	// Later events are not put on top of a transcript that may have a hole.
	store.receive([delta(21, " two")]);
	expect(texts()).toEqual(["saved", "asked", "one"]);
});

test("a chat truncated again after its turn settled shows its settled history", async () => {
	const { store, snapshots, histories, answers, texts } = fakeClient();
	answers.runtime = busy;
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10, { type: "truncated" }));
	await opened;
	answers.runtime = running;
	store.receive([settled(11)]);
	await settle();
	snapshots[1]?.resolve(snapshot(11, { type: "truncated" }));
	await settle();

	expect(
		histories.map(({ projectId, sessionPath }) => [projectId, sessionPath]),
	).toEqual([["p1", "/s.jsonl"]]);
	expect(store.state().status).toBe("ready");
	expect(store.state().source).toBe("history");
	expect(texts()).toEqual(["settled"]);
	// Events are not applied on settled history, and these ask for nothing.
	store.receive([delta(12, "more"), process(13, "running")]);
	await settle();
	expect(texts()).toEqual(["settled"]);
	expect(snapshots.length).toBe(2);
	expect(histories.length).toBe(1);
});

test("a chat on settled history goes back to a snapshot when its next turn starts", async () => {
	const { store, snapshots, histories, answers, texts } = fakeClient();
	answers.runtime = busy;
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10, { type: "truncated" }));
	await opened;
	store.receive([settled(11)]);
	await settle();
	snapshots[1]?.resolve(snapshot(11, { type: "truncated" }));
	await settle();
	expect(store.state().source).toBe("history");

	// The next turn of a local chat can be rebuilt again.
	store.receive([asked(20, "asked"), replying(21)]);
	await settle();
	expect(snapshots.length).toBe(3);
	store.receive([delta(22, "one")]);
	snapshots[2]?.resolve(snapshot(21, turn("")));
	await settle();

	expect(store.state().status).toBe("ready");
	expect(store.state().source).toBe("snapshot");
	expect(texts()).toEqual(["saved", "asked", "one"]);
	// From here the turn streams, with nothing more asked.
	store.receive([delta(23, " two"), settled(24)]);
	await settle();
	expect(texts()).toEqual(["saved", "asked", "one two"]);
	expect(snapshots.length).toBe(3);
	expect(histories.length).toBe(1);
});

test("a chat that stays truncated costs two snapshots and one history read per turn", async () => {
	const { store, snapshots, histories, answers, texts } = fakeClient();
	// A remote chat: its snapshots are truncated even with no turn running.
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10, { type: "truncated" }));
	await opened;
	expect(store.state().status).toBe("ready");
	expect(store.state().source).toBe("history");
	expect(snapshots.length).toBe(1);
	expect(histories.length).toBe(1);

	for (const [turnNumber, base] of [
		[1, 20],
		[2, 40],
	] as const) {
		answers.runtime = busy;
		answers.history = history("settled", `turn ${turnNumber}`);
		store.receive([asked(base, "asked"), replying(base + 1)]);
		await settle();
		// One snapshot when the turn starts.
		expect(snapshots.length).toBe(2 * turnNumber);
		snapshots.at(-1)?.resolve(snapshot(base + 1, { type: "truncated" }));
		await settle();
		// The rest of the turn asks for nothing and shows nothing.
		store.receive([
			delta(base + 2, "one"),
			replying(base + 3),
			asked(base + 4, "steer"),
		]);
		await settle();
		expect(snapshots.length).toBe(2 * turnNumber);
		expect(histories.length).toBe(turnNumber);
		expect(texts()?.at(-1)).toBe(turnNumber === 1 ? "settled" : "turn 1");

		// One snapshot and one history read when it has settled.
		answers.runtime = running;
		store.receive([settled(base + 5)]);
		await settle();
		expect(snapshots.length).toBe(2 * turnNumber + 1);
		snapshots.at(-1)?.resolve(snapshot(base + 5, { type: "truncated" }));
		await settle();
		expect(histories.length).toBe(turnNumber + 1);
		expect(store.state().status).toBe("ready");
		expect(store.state().source).toBe("history");
		expect(texts()).toEqual(["settled", `turn ${turnNumber}`]);
	}
});

test("a turn the runtime state does not report yet is still asked for only once", async () => {
	const { store, snapshots, histories } = fakeClient();
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10, { type: "truncated" }));
	await opened;

	// The turn has started, but the runtime state still says none is running,
	// so the truncated snapshot is answered with settled history at once.
	store.receive([asked(20, "asked")]);
	await settle();
	snapshots[1]?.resolve(snapshot(20, { type: "truncated" }));
	await settle();
	expect(histories.length).toBe(2);
	store.receive([replying(21), delta(22, "one"), replying(23)]);
	await settle();
	expect(snapshots.length).toBe(2);
	expect(histories.length).toBe(2);

	store.receive([settled(24)]);
	await settle();
	expect(snapshots.length).toBe(3);
});

test("a turn that settled while its truncated snapshot was on the way is read again at once", async () => {
	const { store, snapshots, answers, texts } = fakeClient();
	answers.runtime = busy;
	const opened = store.open(target, true);
	await settle();
	store.receive([settled(11)]);
	snapshots[0]?.resolve(snapshot(10, { type: "truncated" }));
	await opened;
	await settle();

	expect(snapshots.length).toBe(2);
	snapshots[1]?.resolve(snapshot(11));
	await settle();
	expect(store.state().status).toBe("ready");
	expect(texts()).toEqual(["saved"]);
});

test("a settle from before a truncated snapshot's cut does not count for it", async () => {
	const { store, snapshots, answers } = fakeClient();
	answers.runtime = busy;
	const opened = store.open(target, true);
	await settle();
	store.receive([settled(9)]);
	snapshots[0]?.resolve(snapshot(10, { type: "truncated" }));
	await opened;
	await settle();

	expect(snapshots.length).toBe(1);
	expect(store.state().status).toBe("loading");
});

for (const [name, event] of [
	["a runtime error", { type: "runtime_error", code: "rpc", message: "x" }],
	["a stopped process", { type: "process_state", state: "stopped" }],
	["a failed process", { type: "process_state", state: "failed" }],
	[
		"a reattached Pi with no turn",
		{ type: "pi_reattached", active: false, compacting: false },
	],
] as const) {
	test(`${name} ends the wait of a truncated chat`, async () => {
		const { store, snapshots, answers } = fakeClient();
		answers.runtime = busy;
		const opened = store.open(target, true);
		await settle();
		snapshots[0]?.resolve(snapshot(10, { type: "truncated" }));
		await opened;

		store.receive([{ ...chat, ...event, sequence: 11 } as PiloClientEvent]);
		await settle();
		expect(snapshots.length).toBe(2);
	});
}

test("a reattached Pi with a turn running does not end the wait", async () => {
	const { store, snapshots, answers } = fakeClient();
	answers.runtime = busy;
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10, { type: "truncated" }));
	await opened;

	store.receive([
		{
			...chat,
			type: "pi_reattached",
			active: true,
			compacting: false,
			sequence: 11,
		} as PiloClientEvent,
	]);
	await settle();
	expect(snapshots.length).toBe(1);
});

for (const [name, state] of [
	["never started", null],
	["stopped", stopped],
	["failed", runtime("failed")],
] as const) {
	test(`a chat whose Pi is ${name} shows its settled history, with no snapshot asked`, async () => {
		const { store, snapshots, histories, answers, texts } = fakeClient();
		answers.runtime = state;
		await store.open(target, true);

		expect(store.state().status).toBe("ready");
		expect(store.state().source).toBe("history");
		expect(texts()).toEqual(["settled"]);
		expect(snapshots.length).toBe(0);
		expect(histories.length).toBe(1);
		expect(histories[0]?.projectId).toBe("p1");
		expect(histories[0]?.sessionPath).toBe("/s.jsonl");
		expect(histories[0]?.options).toEqual(firstWindow);
	});
}

test("the session file the runtime knows is the one read", async () => {
	const { store, histories, answers } = fakeClient();
	answers.runtime = runtime("stopped", 1, { sessionPath: "/runtime.jsonl" });
	await store.open(target, true);

	expect(histories[0]?.sessionPath).toBe("/runtime.jsonl");
});

test("a snapshot is asked for the session's last messages and its index", async () => {
	const { store, snapshots } = fakeClient();
	const opened = store.open(target, true);
	await settle();
	expect(snapshots[0]?.window).toEqual(firstWindow);
	snapshots[0]?.resolve(snapshot(10));
	await opened;
});

test("a chat that was never saved and has no Pi is empty", async () => {
	const { store, snapshots, histories, answers } = fakeClient();
	answers.runtime = null;
	await store.open({ sessionKey: "k1", projectId: "p1" }, true);

	expect(store.state().status).toBe("ready");
	expect(store.state().source).toBe("history");
	expect(store.state().conversation?.messages).toEqual([]);
	expect(snapshots.length).toBe(0);
	expect(histories.length).toBe(0);
});

test("an unsaved chat that stays truncated after its turn is left not loaded", async () => {
	const { store, snapshots, histories, answers } = fakeClient();
	answers.runtime = busy;
	const opened = store.open({ sessionKey: "k1", projectId: "p1" }, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10, { type: "truncated" }));
	await opened;
	store.receive([settled(11)]);
	await settle();
	snapshots[1]?.resolve(snapshot(11, { type: "truncated" }));
	await settle();

	expect(store.state()).toEqual({
		sessionKey: "k1",
		status: "not_loaded",
		conversation: null,
		historyPrefix: [],
		source: null,
	});
	expect(histories.length).toBe(0);
	// It is asked again when its next turn starts, not before.
	store.receive([delta(12, "more")]);
	await settle();
	expect(snapshots.length).toBe(2);
	store.receive([asked(13, "next")]);
	await settle();
	expect(snapshots.length).toBe(3);
});

test("settled history that cannot be read fails the chat and says why", async () => {
	const { store, histories, answers } = fakeClient();
	answers.runtime = null;
	answers.history = null;
	const opened = store.open(target, true);
	await settle();
	histories[0]?.reject(new Error("No such file or directory"));
	await opened;

	expect(store.state()).toEqual({
		sessionKey: "k1",
		status: "failed",
		conversation: null,
		historyPrefix: [],
		source: null,
		message: "No such file or directory",
	});
});

test("settled history that answers after another chat was opened is not shown", async () => {
	const { store, histories, answers, texts } = fakeClient();
	answers.runtime = null;
	answers.history = null;
	const opened = store.open(target, true);
	await settle();
	const other = store.open(
		{ ...target, sessionKey: "k2", sessionPath: "/other.jsonl" },
		true,
	);
	await settle();
	histories[1]?.resolve(history("other chat"));
	await other;
	histories[0]?.resolve(history("first chat"));
	await opened;

	expect(store.state().sessionKey).toBe("k2");
	expect(texts()).toEqual(["other chat"]);
});

test("a failed read says why and keeps the transcript; a refresh reads again", async () => {
	const { store, snapshots, texts } = fakeClient();
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10));
	await opened;

	const refreshed = store.refresh();
	await settle();
	snapshots[1]?.reject(new Error("chat session is not running"));
	await refreshed;
	expect(store.state().status).toBe("failed");
	expect(store.state().message).toBe("chat session is not running");
	expect(texts()).toEqual(["saved"]);
	store.receive([delta(21, "ignored")]);
	expect(texts()).toEqual(["saved"]);

	const again = store.refresh();
	await settle();
	snapshots[2]?.resolve(snapshot(30));
	await again;
	expect(store.state().status).toBe("ready");
	expect(store.state().message).toBe(undefined);
});

test("a snapshot that answers after a newer read or a close is not shown", async () => {
	const { store, snapshots, texts } = fakeClient();
	const opened = store.open(target, true);
	await settle();
	const refreshed = store.refresh();
	await settle();
	snapshots[1]?.resolve(snapshot(20, turn("newer")));
	await refreshed;
	snapshots[0]?.resolve(snapshot(10, turn("older")));
	await opened;
	expect(texts()).toEqual(["saved", "asked", "newer"]);

	const reopened = store.open(target, true);
	await settle();
	store.close();
	snapshots[2]?.resolve(snapshot(30));
	await reopened;
	expect(store.state()).toEqual({
		sessionKey: null,
		status: "closed",
		conversation: null,
		historyPrefix: [],
		source: null,
	});
	store.receive([delta(31, "ignored")]);
	expect(store.state().conversation).toBe(null);
});

test("opening another chat drops the first one's transcript and events", async () => {
	const { store, snapshots, texts } = fakeClient();
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10, turn("one")));
	await opened;

	const other = store.open({ ...target, sessionKey: "k2" }, true);
	expect(store.state().conversation).toBe(null);
	await settle();
	store.receive([delta(11, " first chat")]);
	snapshots[1]?.resolve({ ...snapshot(10), sessionKey: "k2" });
	await other;

	expect(store.state().sessionKey).toBe("k2");
	expect(texts()).toEqual(["saved"]);
});

test("opening another chat without the event stream drops the first one's read", async () => {
	const { store, snapshots } = fakeClient();
	const opened = store.open(target, true);
	await settle();
	expect(snapshots.length).toBe(1);

	await store.open({ ...target, sessionKey: "k2" }, false);
	store.receive([delta(11, "second chat", { sessionKey: "k2" })]);
	snapshots[0]?.resolve(snapshot(10, turn("first chat")));
	await opened;

	expect(store.state()).toEqual({
		sessionKey: "k2",
		status: "loading",
		conversation: null,
		historyPrefix: [],
		source: null,
	});
});

test("a chat showing settled history moves to a snapshot when its Pi starts running", async () => {
	const { store, snapshots, histories, answers, texts } = fakeClient();
	answers.runtime = null;
	await store.open(target, true);
	expect(store.state().source).toBe("history");
	expect(texts()).toEqual(["settled"]);
	expect(answers.reads).toBe(1);

	// Pi is being started for the chat, as the first prompt does.
	answers.runtime = runtime("starting");
	store.receive([process(11, "starting")]);
	await settle();
	expect(answers.reads).toBe(1);
	answers.runtime = running;
	store.receive([process(12, "running")]);
	await settle();
	expect(answers.reads).toBe(2);
	expect(snapshots.length).toBe(1);
	// The settled history stays up while the snapshot is on its way.
	expect(texts()).toEqual(["settled"]);
	// The turn's first events arrive meanwhile.
	store.receive([asked(13, "asked"), replying(14)]);
	snapshots[0]?.resolve(snapshot(12));
	await settle();
	store.receive([delta(15, "one")]);

	expect(store.state().status).toBe("ready");
	expect(store.state().source).toBe("snapshot");
	expect(texts()).toEqual(["saved", "asked", "one"]);
	expect(answers.reads).toBe(2);
	expect(snapshots.length).toBe(1);
	expect(histories.length).toBe(1);
});

test("a chat on settled history is read on the first event of a Pi process it had not seen", async () => {
	const { store, snapshots, answers, texts } = fakeClient();
	answers.runtime = null;
	await store.open(target, true);

	// The process came up without its running state being seen here.
	answers.runtime = running;
	store.receive([delta(11, "one"), delta(12, " two")]);
	await settle();
	expect(answers.reads).toBe(2);
	// The snapshot is taken after those events, so it holds them.
	snapshots[0]?.resolve(snapshot(12, turn("one two")));
	await settle();
	store.receive([delta(13, " three")]);

	expect(store.state().status).toBe("ready");
	expect(texts()).toEqual(["saved", "asked", "one two three"]);
	expect(answers.reads).toBe(2);
	expect(snapshots.length).toBe(1);
});

test("events of a Pi process that is not running do not read the chat again", async () => {
	const { store, snapshots, histories, answers } = fakeClient();
	answers.runtime = stopped;
	await store.open(target, true);
	expect(answers.reads).toBe(1);

	store.receive([
		delta(11, "late"),
		asked(12, "late"),
		process(13, "stopped"),
		settled(14),
	]);
	await settle();
	expect(answers.reads).toBe(1);
	expect(snapshots.length).toBe(0);
	expect(histories.length).toBe(1);
	expect(store.state().source).toBe("history");
});

test("a Pi that is still starting when the chat is read is read again once it runs", async () => {
	const { store, snapshots, answers, texts } = fakeClient();
	answers.runtime = runtime("starting");
	const opened = store.open(target, true);
	// The running state arrives before the read of the starting one is done.
	store.receive([process(11, "running")]);
	answers.runtime = running;
	await opened;
	await settle();

	expect(answers.reads).toBe(2);
	snapshots[0]?.resolve(snapshot(11));
	await settle();
	expect(store.state().status).toBe("ready");
	expect(texts()).toEqual(["saved"]);
});

test("the first event of an unseen Pi process during a read that finds none reads again", async () => {
	const { store, snapshots, answers, texts } = fakeClient();
	answers.runtime = null;
	const opened = store.open(target, true);
	store.receive([delta(11, "one")]);
	answers.runtime = running;
	await opened;
	await settle();

	expect(answers.reads).toBe(2);
	snapshots[0]?.resolve(snapshot(11, turn("one")));
	await settle();
	expect(store.state().status).toBe("ready");
	expect(texts()).toEqual(["saved", "asked", "one"]);
	// Had the process gone again, its events would not read a third time.
	expect(snapshots.length).toBe(1);
});

test("a failed chat is read again when a newer Pi process runs, not by the old one's events", async () => {
	const { store, snapshots, answers, texts } = fakeClient();
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.reject(new Error("chat session is closing"));
	await opened;
	expect(store.state().status).toBe("failed");

	store.receive([delta(11, "old"), settled(12)]);
	await settle();
	expect(answers.reads).toBe(1);

	answers.runtime = runtime("running", 2);
	store.receive([process(13, "running", 2)]);
	await settle();
	expect(answers.reads).toBe(2);
	snapshots[1]?.resolve(snapshot(13, { type: "idle" }, 2));
	await settle();
	expect(store.state().status).toBe("ready");
	expect(store.state().message).toBe(undefined);
	expect(texts()).toEqual(["saved"]);
});

test("a chat opened without the event stream waits for a refresh", async () => {
	const { store, snapshots, texts } = fakeClient();
	await store.open(target, false);
	await settle();
	expect(snapshots.length).toBe(0);
	expect(store.state().status).toBe("loading");

	const refreshed = store.refresh();
	await settle();
	snapshots[0]?.resolve(snapshot(10));
	await refreshed;
	expect(texts()).toEqual(["saved"]);
});

test("a refresh with no chat open asks for nothing", async () => {
	const { store, snapshots } = fakeClient();
	await store.refresh();
	expect(snapshots.length).toBe(0);
	expect(store.state().status).toBe("closed");
});

/** An app store over a client the test drives, with its chat transcript. */
function fakeApp() {
	const listeners = new Set<PiloClientEventOptions>();
	const bootstraps: Reply<NshPiloClientBootstrap>[] = [];
	const { store: chatStore, snapshots, texts } = fakeClient();
	const client: AppStoreClient = {
		closed: false,
		bootstrap: () =>
			new Promise((resolve, reject) => bootstraps.push({ resolve, reject })),
		chatState: () => Promise.resolve(null),
		listProjects: () => Promise.resolve([]),
		listSessions: () => Promise.resolve([]),
		loadSessionReadStates: () => Promise.resolve([]),
		markSessionRead: () => Promise.reject(new Error("unused")),
		loadThemeSettings: () =>
			Promise.resolve({ revision: 1 } as Awaited<
				ReturnType<AppStoreClient["loadThemeSettings"]>
			>),
		connectEvents(options) {
			listeners.add(options);
			return Promise.resolve(() => void listeners.delete(options));
		},
	};
	const bootstrap = (latestSequence: number) =>
		({
			projects: [],
			chatSessions: [],
			latestSequence,
			preferences: { revision: 1 },
		}) as unknown as NshPiloClientBootstrap;
	const send = (...events: PiloClientEvent[]) => {
		for (const listener of [...listeners]) {
			listener.onMessage({ type: "events", events });
		}
	};
	const gap = () => {
		for (const listener of [...listeners]) {
			listener.onMessage({ type: "resyncRequired", latestSequence: 20 });
		}
	};
	const drop = () => {
		for (const listener of [...listeners]) listener.onStatus?.(false);
	};
	return {
		app: new AppStore(client, chatStore),
		chatStore,
		snapshots,
		bootstraps,
		bootstrap,
		texts,
		send,
		gap,
		drop,
	};
}

test("the app store passes a chat's events on while its own bootstrap is in flight", async () => {
	const { app, chatStore, snapshots, bootstraps, bootstrap, texts, send } =
		fakeApp();
	const started = app.start();
	await settle();
	expect(app.connected).toBe(true);
	const opened = chatStore.open(target, app.connected);
	await settle();
	snapshots[0]?.resolve(snapshot(10, turn("one")));
	await opened;

	// The bootstrap has not answered, so the app's own events are waiting.
	expect(app.state().status.type).toBe("starting");
	send(delta(11, " two"));
	expect(texts()).toEqual(["saved", "asked", "one two"]);

	bootstraps[0]?.resolve(bootstrap(11));
	await started;
	send(delta(12, " three"));
	expect(texts()).toEqual(["saved", "asked", "one two three"]);
});

test("a gap in the event stream reads the open chat again", async () => {
	const { app, chatStore, snapshots, bootstraps, bootstrap, texts, send, gap } =
		fakeApp();
	const started = app.start();
	await settle();
	bootstraps[0]?.resolve(bootstrap(5));
	await started;
	const opened = chatStore.open(target, app.connected);
	await settle();
	snapshots[0]?.resolve(snapshot(10, turn("one")));
	await opened;

	gap();
	await settle();
	expect(snapshots.length).toBe(2);
	send(delta(31, " three"));
	snapshots[1]?.resolve(snapshot(30, turn("one two")));
	bootstraps[1]?.resolve(bootstrap(30));
	await settle();

	expect(texts()).toEqual(["saved", "asked", "one two three"]);
});

test("a reconnected event stream reads the open chat again", async () => {
	const { app, chatStore, snapshots, bootstraps, bootstrap, texts, drop } =
		fakeApp();
	const started = app.start();
	await settle();
	bootstraps[0]?.resolve(bootstrap(5));
	await started;
	const opened = chatStore.open(target, app.connected);
	await settle();
	snapshots[0]?.resolve(snapshot(10, turn("one")));
	await opened;

	drop();
	await settle();
	expect(app.connected).toBe(true);
	expect(snapshots.length).toBe(2);
	snapshots[1]?.resolve(snapshot(40, turn("one two")));
	bootstraps[1]?.resolve(bootstrap(40));
	await settle();

	expect(chatStore.state().status).toBe("ready");
	expect(texts()).toEqual(["saved", "asked", "one two"]);
});

test("a chat opened before the app connected is read when it connects", async () => {
	const { app, chatStore, snapshots, bootstraps, bootstrap, texts } = fakeApp();
	await chatStore.open(target, app.connected);
	expect(snapshots.length).toBe(0);

	const started = app.start();
	await settle();
	expect(snapshots.length).toBe(1);
	snapshots[0]?.resolve(snapshot(10));
	bootstraps[0]?.resolve(bootstrap(10));
	await started;
	await settle();

	expect(texts()).toEqual(["saved"]);
});

test("the store follows a chat's transcript through the native module", async () => {
	const app = await open("./chat-transcript-store-fixture.tsx");
	await app.waitFor("text:chat transcript followed through the store", {
		timeout: 30_000,
	});
});

test("the store shows a saved chat's settled history through the native module", async () => {
	const app = await open("./chat-transcript-history-fixture.tsx");
	await app.waitFor("text:settled history shown through the store", {
		timeout: 30_000,
	});
});

test("the saved messages before the loaded ones are placeholders from the session's index", async () => {
	const { store, answers, texts } = fakeClient();
	answers.runtime = null;
	answers.history = windowed(6, 4);
	await store.open(target, true);

	expect(texts()).toEqual(["question 4", "reply 5"]);
	expect(store.state().historyPrefix).toEqual(
		[0, 1, 2, 3].map((at) => ({
			id: `entry-${at}`,
			role: at % 2 === 0 ? "user" : "assistant",
			text: `preview ${at}`,
			time: "",
			timestampMs: undefined,
			historyPlaceholder: true,
			historyEstimatedChars: 100 + at,
		})),
	);
});

test("a loaded message has the id of its index entry, which its placeholder would have", async () => {
	const { store, answers } = fakeClient();
	answers.runtime = null;
	answers.history = windowed(6, 2);
	await store.open(target, true);

	expect(store.messages().map(({ id }) => id)).toEqual(
		[0, 1, 2, 3, 4, 5].map((at) => `entry-${at}`),
	);
	expect(
		store.messages().map((message) => message.historyPlaceholder === true),
	).toEqual([true, true, false, false, false, false]);
});

test("a snapshot's saved messages take the index ids and the turn's keep their own", async () => {
	const { store, snapshots } = fakeClient();
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve({
		...snapshot(10, turn("one")),
		history: windowed(4, 2),
	});
	await opened;

	expect(store.state().source).toBe("snapshot");
	expect(store.state().historyPrefix.map(({ id }) => id)).toEqual([
		"entry-0",
		"entry-1",
	]);
	const loaded = store.state().conversation?.messages ?? [];
	expect(loaded.map(({ text }) => text)).toEqual([
		"question 2",
		"reply 3",
		"asked",
		"one",
	]);
	expect(loaded.slice(0, 2).map(({ id }) => id)).toEqual([
		"entry-2",
		"entry-3",
	]);
	// The running turn is in no index yet.
	expect(loaded.slice(2).some(({ id }) => id.startsWith("entry-"))).toBe(false);
});

test("a read with no message index, or of the whole session, has no placeholders", async () => {
	const { store, answers } = fakeClient();
	answers.runtime = null;
	await store.open(target, true);
	expect(store.state().historyPrefix).toEqual([]);
	// With nothing before them, the messages are the conversation's own array.
	expect(store.messages()).toBe(store.state().conversation?.messages);

	answers.history = windowed(4, 0);
	await store.open(target, true);
	expect(store.state().historyPrefix).toEqual([]);
	expect(store.messages().length).toBe(4);
});

test("a streaming turn changes the conversation and leaves the placeholders as they are", async () => {
	const { store, snapshots } = fakeClient();
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve({
		...snapshot(10, turn("one")),
		history: windowed(500, 420),
	});
	await opened;
	const prefix = store.state().historyPrefix;
	const before = store.state().conversation;
	expect(prefix.length).toBe(420);

	store.receive([delta(11, " two")]);
	store.receive([delta(12, " three")]);

	expect(store.state().conversation).not.toBe(before);
	expect(store.state().historyPrefix).toBe(prefix);
	const messages = store.messages();
	expect(messages.length).toBe(420 + 80 + 2);
	expect(messages.at(-1)?.text).toBe("one two three");
	expect(messages[419]).toBe(prefix[419]);
	// Joined once for what the chat holds now, and again only after a change.
	expect(store.messages()).toBe(messages);
	store.receive([delta(13, " four")]);
	expect(store.messages()).not.toBe(messages);
	expect(store.messages().at(-1)?.text).toBe("one two three four");
});

test("a later read replaces the placeholders, and they stay while it is awaited", async () => {
	const { store, answers, histories } = fakeClient();
	answers.runtime = null;
	answers.history = windowed(6, 4);
	await store.open(target, true);
	const prefix = store.state().historyPrefix;

	answers.history = null;
	const refreshed = store.refresh();
	await settle();
	expect(store.state().status).toBe("loading");
	expect(store.state().historyPrefix).toBe(prefix);

	histories[1]?.resolve(windowed(8, 5));
	await refreshed;
	expect(store.state().historyPrefix.map(({ id }) => id)).toEqual(
		[0, 1, 2, 3, 4].map((at) => `entry-${at}`),
	);
	expect(store.messages().length).toBe(8);
});

test("another chat, a failed read and a closed store do not show a chat's placeholders", async () => {
	const { store, answers, histories } = fakeClient();
	answers.runtime = null;
	answers.history = windowed(6, 4);
	await store.open(target, true);
	expect(store.state().historyPrefix.length).toBe(4);

	answers.history = null;
	const other = store.open({ ...target, sessionKey: "k2" }, true);
	expect(store.state().historyPrefix).toEqual([]);
	expect(store.messages()).toEqual([]);
	await settle();
	histories[1]?.reject(new Error("no such file"));
	await other;
	expect(store.state().status).toBe("failed");
	expect(store.state().historyPrefix).toEqual([]);

	answers.history = windowed(6, 4);
	await store.open(target, true);
	store.close();
	expect(store.state().historyPrefix).toEqual([]);
	expect(store.messages()).toEqual([]);
});

test("a long session shows its last messages over placeholders, through the native module", async () => {
	const app = await open("./chat-transcript-window-fixture.tsx");
	await app.waitFor("text:long session shown through the store", {
		timeout: 60_000,
	});
});

/** A saved chat of `total` messages with no Pi, opened on its last 80. */
async function longChat(total = 600) {
	const fake = fakeClient();
	fake.answers.runtime = null;
	fake.answers.history = windowed(total, total - 80);
	fake.answers.pages = total;
	await fake.store.open(target, true);
	/** Which messages are loaded, as the indexes of the first and last of each run. */
	const loaded = () => {
		const runs: [number, number][] = [];
		for (const [at, message] of fake.store.messages().entries()) {
			if (message.historyPlaceholder) continue;
			const last = runs.at(-1);
			if (last && last[1] === at - 1) last[1] = at;
			else runs.push([at, at]);
		}
		return runs;
	};
	/** Whether message `i` of the session is at index `i`, loaded or not. */
	const inPlace = () =>
		fake.store.messages().every((message, at) => message.id === `entry-${at}`);
	return { ...fake, loaded, inPlace };
}

test("a range is loaded in the WebUI's pages, each message in its place", async () => {
	const { store, histories, pages, loaded, inPlace } = await longChat();
	expect(loaded()).toEqual([[520, 599]]);
	const before = store.messages();
	const { conversation } = store.state();

	store.loadRange(300, 320);
	// 16 messages around the range, in pages of 48 from a multiple of 48.
	expect(pages()).toEqual([
		[240, 48],
		[288, 48],
		[336, 48],
	]);
	expect(histories[1]?.options).toEqual({
		startMessage: 240,
		messageLimit: 48,
		includeMessageIndex: false,
		fingerprint: { fileSize: 600, fileMtimeNs: "1" },
	});
	expect(histories[1]?.projectId).toBe("p1");
	expect(histories[1]?.sessionPath).toBe("/s.jsonl");
	await settle();

	expect(loaded()).toEqual([
		[240, 383],
		[520, 599],
	]);
	const messages = store.messages();
	expect(messages.length).toBe(600);
	expect(inPlace()).toBe(true);
	expect(messages[240]?.text).toBe("question 240");
	expect(messages[383]?.text).toBe("reply 383");
	// The rest are the placeholders they were.
	expect(messages[239]).toBe(before[239]);
	expect(messages[384]).toBe(before[384]);
	// The loaded messages of the chat are not touched.
	expect(store.state().conversation).toBe(conversation);
	expect(store.state().status).toBe("ready");
});

test("what is loaded or on its way is not read again", async () => {
	const { store, answers, histories, pages, loaded } = await longChat();
	answers.pages = null;
	store.loadRange(300, 320);
	store.loadRange(300, 320);
	store.loadRange(310, 330);
	expect(pages().length).toBe(3);

	for (const read of histories.slice(1)) {
		read.resolve(
			windowed(
				600,
				read.options?.startMessage ?? 0,
				read.options?.messageLimit,
			),
		);
	}
	await settle();
	store.loadRange(300, 320);
	expect(pages().length).toBe(3);

	// Only the page that is new to the range.
	answers.pages = 600;
	store.loadRange(330, 400);
	expect(pages().slice(3)).toEqual([[384, 48]]);
	await settle();
	expect(loaded()).toEqual([
		[240, 431],
		[520, 599],
	]);
});

test("the page before the loaded messages ends where they begin", async () => {
	const { store, pages, loaded } = await longChat();
	// Wholly among the loaded messages and far from the first of them.
	store.loadRange(560, 580);
	expect(pages()).toEqual([]);

	// At the top of the loaded messages, the ones just before are read.
	store.loadRange(525, 540);
	expect(pages()).toEqual([[480, 40]]);
	await settle();
	expect(loaded()).toEqual([[480, 599]]);
});

test("beyond 200 loaded messages the oldest outside the range go back to placeholders, in place", async () => {
	const { store, loaded, inPlace } = await longChat(1_000);
	store.loadRange(0, 100);
	await settle();
	expect(loaded()).toEqual([
		[0, 143],
		[920, 999],
	]);
	const first = store.messages()[0];

	store.loadRange(400, 500);
	await settle();
	// 288 were loaded; the range asked for stays, the oldest 88 do not.
	expect(loaded()).toEqual([
		[88, 143],
		[384, 527],
		[920, 999],
	]);
	expect(store.messages().length).toBe(1_000);
	expect(inPlace()).toBe(true);
	expect(store.messages()[0]).toEqual({
		id: "entry-0",
		role: "user",
		text: "preview 0",
		time: "",
		timestampMs: undefined,
		historyPlaceholder: true,
		historyEstimatedChars: 100,
	});
	expect(first?.text).toBe("question 0");

	// Asked for again, they are read again.
	store.loadRange(0, 10);
	await settle();
	expect(store.messages()[0]?.text).toBe("question 0");
	expect(inPlace()).toBe(true);
});

test("a read with a new window keeps every message at its index and loads the range again", async () => {
	const { store, answers, pages, loaded, inPlace } = await longChat();
	store.loadRange(300, 320);
	await settle();

	// Two turns later the session is four messages longer.
	answers.history = windowed(604, 524);
	answers.pages = 604;
	await store.refresh();
	expect(store.messages().length).toBe(604);
	expect(inPlace()).toBe(true);
	expect(pages().slice(3)).toEqual([
		[240, 48],
		[288, 48],
		[336, 48],
	]);
	await settle();

	expect(loaded()).toEqual([
		[240, 383],
		[524, 603],
	]);
	expect(inPlace()).toBe(true);
	expect(store.messages()[520]?.historyPlaceholder).toBe(true);
	expect(store.messages()[520]?.id).toBe("entry-520");
});

test("a page of a file that changed since the read reads the chat once more, then loads", async () => {
	const { store, answers, histories, pages, loaded, inPlace } =
		await longChat();
	// The file grew after the chat was read.
	answers.history = windowed(602, 522);
	answers.pages = 602;
	store.loadRange(300, 320);
	await settle();
	await settle();

	// Three pages of the changed file, one read of the chat, three pages.
	expect(histories.length - pages().length).toBe(2);
	expect(pages().length).toBe(6);
	expect(
		histories.slice(-3).map(({ options }) => options?.fingerprint?.fileSize),
	).toEqual([602, 602, 602]);
	expect(loaded()).toEqual([
		[240, 383],
		[522, 601],
	]);
	expect(inPlace()).toBe(true);
});

test("pages that keep coming from a changed file read the chat once for each change of it", async () => {
	const { store, answers, histories, pages, loaded } = await longChat();
	const chatReads = () => histories.length - pages().length;
	const settleAll = async () => {
		for (let turn = 0; turn < 4; turn += 1) await settle();
	};
	// Every page says the file is not the one the chat was read from, and
	// reading the chat again does not get it onto that file.
	answers.pages = 602;
	store.loadRange(300, 320);
	await settleAll();
	expect(chatReads()).toBe(2);
	expect(pages().length).toBe(6);
	expect(loaded()).toEqual([[520, 599]]);
	expect(store.state().status).toBe("ready");

	// A list that scrolls asks for range after range: no further read.
	for (let at = 0; at < 25; at += 1) {
		store.loadRange(at * 20, at * 20 + 20);
		await settle();
	}
	await settleAll();
	expect(chatReads()).toBe(2);
	expect(pages().length).toBeGreaterThan(20);
	expect(loaded()).toEqual([[520, 599]]);

	// The file changes again: one more read, and no more for that file.
	answers.pages = 604;
	for (let at = 0; at < 25; at += 1) {
		store.loadRange(at * 20, at * 20 + 20);
		await settle();
	}
	await settleAll();
	expect(chatReads()).toBe(3);

	// Once a read gets the chat onto the file the pages come from, they load.
	answers.history = windowed(606, 526);
	answers.pages = 606;
	store.loadRange(300, 320);
	await settleAll();
	expect(chatReads()).toBe(4);
	expect(loaded()).toEqual([
		[240, 383],
		[526, 605],
	]);
});

test("a range that could not be loaded during a turn is loaded when the turn is over", async () => {
	const { store, snapshots, answers } = fakeClient();
	// The runtime answers pages from a newer file than the one the turn
	// started on, which is the file a snapshot of the turn is of.
	answers.pages = 602;
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve({
		...snapshot(10, turn("one")),
		history: windowed(600, 520),
	});
	await opened;
	store.loadRange(300, 320);
	await settle();
	expect(snapshots.length).toBe(2);
	snapshots[1]?.resolve({
		...snapshot(20, turn("one")),
		history: windowed(600, 520),
	});
	await settle();
	await settle();

	for (let at = 0; at < 25; at += 1) {
		store.loadRange(at * 20, at * 20 + 20);
		await settle();
	}
	store.loadRange(300, 320);
	await settle();
	expect(snapshots.length).toBe(2);
	expect(store.messages()[300]?.historyPlaceholder).toBe(true);

	// The turn settles, and a snapshot is then of the file as it is.
	store.receive([settled(21)]);
	await settle();
	expect(snapshots.length).toBe(3);
	snapshots[2]?.resolve({ ...snapshot(30), history: windowed(602, 522) });
	await settle();
	await settle();
	expect(store.messages()[300]?.text).toBe("question 300");
	expect(store.messages().length).toBe(602);
	expect(snapshots.length).toBe(3);
});

test("a page that arrives for a chat no longer open, or after a newer read, is dropped", async () => {
	const { store, answers, histories, loaded } = await longChat();
	answers.pages = null;
	store.loadRange(300, 320);
	const pending = histories.slice(1);

	await store.refresh();
	pending[0]?.resolve(windowed(600, 240, 48));
	await settle();
	// The read replaced the placeholders the page was asked for.
	expect(loaded()).toEqual([[520, 599]]);

	answers.history = windowed(6, 4);
	await store.open({ ...target, sessionKey: "k2" }, true);
	pending[1]?.resolve(windowed(600, 288, 48));
	pending[2]?.reject(new Error("too late"));
	await settle();
	expect(store.state().sessionKey).toBe("k2");
	expect(store.messages().map(({ id }) => id)).toEqual(
		[0, 1, 2, 3, 4, 5].map((at) => `entry-${at}`),
	);
	expect(store.state().historyPrefix.every((m) => m.historyPlaceholder)).toBe(
		true,
	);
});

test("a page that fails stays as placeholders and is read when asked for again", async () => {
	const { store, answers, histories, pages, loaded, inPlace } =
		await longChat();
	answers.pages = null;
	store.loadRange(240, 250);
	expect(pages()).toEqual([
		[192, 48],
		[240, 48],
	]);
	histories[1]?.reject(new Error("the runtime did not answer"));
	histories[2]?.resolve(windowed(600, 240, 48));
	await settle();

	expect(store.state().status).toBe("ready");
	expect(loaded()).toEqual([
		[240, 287],
		[520, 599],
	]);
	expect(inPlace()).toBe(true);

	answers.pages = 600;
	store.loadRange(240, 250);
	expect(pages().slice(2)).toEqual([[192, 48]]);
	await settle();
	expect(loaded()).toEqual([
		[192, 287],
		[520, 599],
	]);
});

test("a range asked for while the chat is being read is loaded when the read is done", async () => {
	const { store, answers, histories, pages } = fakeClient();
	answers.runtime = null;
	answers.history = null;
	answers.pages = 600;
	const opened = store.open(target, true);
	await settle();
	store.loadRange(300, 320);
	expect(pages()).toEqual([]);

	histories[0]?.resolve(windowed(600, 520));
	await opened;
	expect(pages().length).toBe(3);
	await settle();
	expect(store.messages()[300]?.text).toBe("question 300");
});

test("without the file's fingerprint or its path, placeholders are not loaded", async () => {
	const { store, answers, pages } = fakeClient();
	answers.runtime = null;
	answers.pages = 600;
	answers.history = { ...windowed(600, 520), fingerprint: null };
	await store.open(target, true);
	store.loadRange(300, 320);
	expect(store.state().historyPrefix.length).toBe(520);
	expect(pages()).toEqual([]);

	// A closed store has nothing to load either.
	store.close();
	store.loadRange(300, 320);
	expect(pages()).toEqual([]);
});

test("a running chat loads its older messages from the session file and goes on streaming", async () => {
	const { store, snapshots, answers, histories, pages } = fakeClient();
	answers.pages = 600;
	const opened = store.open(target, true);
	await settle();
	snapshots[0]?.resolve({
		...snapshot(10, turn("one")),
		history: windowed(600, 520),
	});
	await opened;

	store.loadRange(300, 320);
	expect(pages().length).toBe(3);
	expect(histories[0]?.sessionPath).toBe("/s.jsonl");
	await settle();
	const prefix = store.state().historyPrefix;
	expect(prefix[300]?.text).toBe("question 300");
	expect(snapshots.length).toBe(1);

	store.receive([delta(11, " two")]);
	expect(store.state().historyPrefix).toBe(prefix);
	expect(store.messages().length).toBe(602);
	expect(store.messages()[300]).toBe(prefix[300]);
	expect(store.messages().at(-1)?.text).toBe("one two");

	// A fresh snapshot starts from placeholders and loads the range again.
	const refreshed = store.refresh();
	await settle();
	snapshots[1]?.resolve({
		...snapshot(20, turn("one two")),
		history: windowed(600, 520),
	});
	await refreshed;
	expect(pages().length).toBe(6);
	await settle();
	expect(store.messages()[300]?.text).toBe("question 300");
});

test("the range asked for last stays loaded, though its pages were loaded first", async () => {
	const { store, answers, histories, loaded, inPlace } = await longChat(1_000);
	answers.pages = null;
	store.loadRange(0, 100);
	store.loadRange(400, 500);
	const [early, late] = [histories.slice(1, 4), histories.slice(4)];
	const answer = (read: (typeof histories)[number]) =>
		read.resolve(
			windowed(
				1_000,
				read.options?.startMessage ?? 0,
				read.options?.messageLimit,
			),
		);
	// The pages of the range now shown arrive before the ones left behind.
	for (const read of late) answer(read);
	await settle();
	for (const read of early) answer(read);
	await settle();

	// 288 were loaded. What goes is outside the range, oldest first.
	expect(loaded()).toEqual([
		[77, 143],
		[384, 516],
		[920, 999],
	]);
	expect(inPlace()).toBe(true);
});

test("a range asked for during a later read of the chat waits for that read", async () => {
	const { store, answers, histories, pages, loaded } = await longChat();
	answers.history = null;
	const refreshed = store.refresh();
	await settle();
	expect(store.state().status).toBe("loading");
	store.loadRange(300, 320);
	expect(pages()).toEqual([]);

	histories[1]?.resolve(windowed(600, 520));
	await refreshed;
	expect(pages().length).toBe(3);
	await settle();
	expect(loaded()).toEqual([
		[240, 383],
		[520, 599],
	]);
});

test("pages that load during a read that fails stay loaded", async () => {
	const { store, answers, histories, loaded, inPlace } = await longChat();
	answers.pages = null;
	store.loadRange(300, 320);
	answers.history = null;
	const refreshed = store.refresh();
	await settle();
	for (const read of histories.slice(1, 4)) {
		read.resolve(
			windowed(
				600,
				read.options?.startMessage ?? 0,
				read.options?.messageLimit,
			),
		);
	}
	await settle();
	expect(loaded()).toEqual([
		[240, 383],
		[520, 599],
	]);

	histories[4]?.reject(new Error("the runtime did not answer"));
	await refreshed;
	expect(store.state().status).toBe("failed");
	expect(loaded()).toEqual([
		[240, 383],
		[520, 599],
	]);
	expect(inPlace()).toBe(true);
});

test("the range asked for in one chat is not loaded in the next", async () => {
	const { store, answers, pages } = await longChat();
	store.loadRange(300, 320);
	await settle();
	expect(pages().length).toBe(3);

	answers.history = windowed(900, 820);
	answers.pages = 900;
	await store.open({ ...target, sessionKey: "k2" }, true);
	await settle();
	expect(store.state().historyPrefix.length).toBe(820);
	expect(pages().length).toBe(3);
});

test("after pages have loaded, a later page of a changed file reads the chat again", async () => {
	const { store, answers, histories, pages, loaded } = await longChat();
	answers.history = windowed(602, 522);
	answers.pages = 602;
	store.loadRange(300, 320);
	await settle();
	await settle();
	expect(histories.length - pages().length).toBe(2);
	expect(loaded()).toEqual([
		[240, 383],
		[522, 601],
	]);

	// The stream lost events, and the file has changed again by the time
	// the range is loaded for the new read.
	answers.pages = 604;
	await store.refresh();
	await settle();
	await settle();
	expect(histories.length - pages().length).toBe(4);
	expect(pages().length).toBe(12);
});

test("a file one chat was read again for does not keep the next chat from being read again", async () => {
	const { store, answers, histories, pages } = await longChat();
	const chatReads = () => histories.length - pages().length;
	answers.pages = 602;
	store.loadRange(300, 320);
	await settle();
	await settle();
	expect(chatReads()).toBe(2);

	// Another chat whose pages come from a file with that same fingerprint.
	await store.open({ ...target, sessionKey: "k2" }, true);
	expect(chatReads()).toBe(3);
	store.loadRange(300, 320);
	await settle();
	await settle();
	expect(chatReads()).toBe(4);
});
