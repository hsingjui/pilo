import { expect, open, test } from "nsh/test";

import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-types";
import type {
	PiloClientEvent,
	PiloClientEventOptions,
} from "@/lib/api/pilo-client";
import type { ConversationReducerContext } from "@/lib/chat/conversation-types";
import type {
	ChatTranscriptSnapshot,
	NshPiloClientBootstrap,
} from "../client/nsh-pilo-client";
import { AppStore, type AppStoreClient } from "../state/app-store";
import {
	type ChatTranscriptClient,
	ChatTranscriptStore,
} from "../state/chat-transcript-store";

const chat = { sessionKey: "k1", projectId: "p1", generation: 1 };

function context(): ConversationReducerContext {
	let id = 0;
	return {
		createMessageId: (kind) => `${kind}-${++id}`,
		createContentId: (kind) => `${kind}-${++id}`,
		now: () => 0,
		formatTime: () => "00:00",
	};
}

const runtime = (state: string, generation = chat.generation) =>
	({ snapshot: { state, generation } }) as ChatSessionRuntimeState;
const running = runtime("running");
const stopped = runtime("stopped");
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

type Reply<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

/** A client whose snapshot calls the test answers one at a time. */
function fakeClient() {
	const snapshots: Reply<ChatTranscriptSnapshot>[] = [];
	const answers = {
		runtime: running as ChatSessionRuntimeState | null,
		/** How many times the runtime state was read. */
		reads: 0,
	};
	const client: ChatTranscriptClient = {
		chatState() {
			answers.reads += 1;
			return Promise.resolve(answers.runtime);
		},
		chatTranscriptSnapshot: () =>
			new Promise((resolve, reject) => snapshots.push({ resolve, reject })),
	};
	const store = new ChatTranscriptStore(client, context());
	const texts = () =>
		store.state().conversation?.messages.map((message) => message.text);
	return { store, snapshots, answers, texts };
}

/** Lets the calls already answered run to their next wait. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("a chat opens as loading and shows its snapshot", async () => {
	const { store, snapshots, texts } = fakeClient();
	expect(store.state().status).toBe("closed");

	const opened = store.open(chat.sessionKey, true);
	expect(store.state()).toEqual({
		sessionKey: "k1",
		status: "loading",
		conversation: null,
	});
	await settle();
	snapshots[0]?.resolve(snapshot(10));
	await opened;

	expect(store.state().status).toBe("ready");
	expect(texts()).toEqual(["saved"]);
});

test("events that arrive while the snapshot is awaited are applied above its cut only", async () => {
	const { store, snapshots, texts } = fakeClient();
	const opened = store.open(chat.sessionKey, true);
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
	const opened = store.open(chat.sessionKey, true);
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
	const opened = store.open(chat.sessionKey, true);
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
	const opened = store.open(chat.sessionKey, true);
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
	const opened = store.open(chat.sessionKey, true);
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
	const { store, snapshots, texts } = fakeClient();
	const opened = store.open(chat.sessionKey, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10, { type: "truncated" }));
	await opened;

	// Its empty history is not the chat's, so the chat is still loading.
	expect(store.state()).toEqual({
		sessionKey: "k1",
		status: "loading",
		conversation: null,
	});
	// The running turn's events are not applied, and ask for nothing.
	store.receive([delta(11, "partial"), delta(12, " reply")]);
	await settle();
	expect(snapshots.length).toBe(1);
	expect(store.state().conversation).toBe(null);

	store.receive([settled(13)]);
	await settle();
	expect(snapshots.length).toBe(2);
	snapshots[1]?.resolve(snapshot(13));
	await settle();

	expect(store.state().status).toBe("ready");
	expect(texts()).toEqual(["saved"]);
});

test("a truncated snapshot keeps the transcript the chat showed before", async () => {
	const { store, snapshots, texts } = fakeClient();
	const opened = store.open(chat.sessionKey, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10, turn("one")));
	await opened;

	const refreshed = store.refresh();
	await settle();
	snapshots[1]?.resolve(snapshot(20, { type: "truncated" }));
	await refreshed;

	expect(store.state().status).toBe("loading");
	expect(texts()).toEqual(["saved", "asked", "one"]);
	// Later events are not put on top of a transcript that may have a hole.
	store.receive([delta(21, " two")]);
	expect(texts()).toEqual(["saved", "asked", "one"]);
});

test("a chat that is truncated again after its turn settled is not asked a third time", async () => {
	const { store, snapshots } = fakeClient();
	const opened = store.open(chat.sessionKey, true);
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
	});
	// Later turns settling do not start it over.
	store.receive([delta(12, "more"), settled(13), settled(14)]);
	await settle();
	expect(snapshots.length).toBe(2);
});

test("a turn that settled while its truncated snapshot was on the way is read again at once", async () => {
	const { store, snapshots, texts } = fakeClient();
	const opened = store.open(chat.sessionKey, true);
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
	const { store, snapshots } = fakeClient();
	const opened = store.open(chat.sessionKey, true);
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
		const { store, snapshots } = fakeClient();
		const opened = store.open(chat.sessionKey, true);
		await settle();
		snapshots[0]?.resolve(snapshot(10, { type: "truncated" }));
		await opened;

		store.receive([{ ...chat, ...event, sequence: 11 } as PiloClientEvent]);
		await settle();
		expect(snapshots.length).toBe(2);
	});
}

test("a reattached Pi with a turn running does not end the wait", async () => {
	const { store, snapshots } = fakeClient();
	const opened = store.open(chat.sessionKey, true);
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

for (const [name, runtime] of [
	["never started", null],
	["stopped", stopped],
] as const) {
	test(`a chat whose Pi is ${name} is left not loaded, with no snapshot asked`, async () => {
		const { store, snapshots, answers } = fakeClient();
		answers.runtime = runtime;
		await store.open(chat.sessionKey, true);

		expect(store.state()).toEqual({
			sessionKey: "k1",
			status: "not_loaded",
			conversation: null,
		});
		expect(snapshots.length).toBe(0);
		store.receive([delta(11, "text"), settled(12)]);
		await settle();
		expect(snapshots.length).toBe(0);
	});
}

test("a failed read says why and keeps the transcript; a refresh reads again", async () => {
	const { store, snapshots, texts } = fakeClient();
	const opened = store.open(chat.sessionKey, true);
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
	const opened = store.open(chat.sessionKey, true);
	await settle();
	const refreshed = store.refresh();
	await settle();
	snapshots[1]?.resolve(snapshot(20, turn("newer")));
	await refreshed;
	snapshots[0]?.resolve(snapshot(10, turn("older")));
	await opened;
	expect(texts()).toEqual(["saved", "asked", "newer"]);

	const reopened = store.open(chat.sessionKey, true);
	await settle();
	store.close();
	snapshots[2]?.resolve(snapshot(30));
	await reopened;
	expect(store.state()).toEqual({
		sessionKey: null,
		status: "closed",
		conversation: null,
	});
	store.receive([delta(31, "ignored")]);
	expect(store.state().conversation).toBe(null);
});

test("opening another chat drops the first one's transcript and events", async () => {
	const { store, snapshots, texts } = fakeClient();
	const opened = store.open(chat.sessionKey, true);
	await settle();
	snapshots[0]?.resolve(snapshot(10, turn("one")));
	await opened;

	const other = store.open("k2", true);
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
	const opened = store.open(chat.sessionKey, true);
	await settle();
	expect(snapshots.length).toBe(1);

	await store.open("k2", false);
	store.receive([delta(11, "second chat", { sessionKey: "k2" })]);
	snapshots[0]?.resolve(snapshot(10, turn("first chat")));
	await opened;

	expect(store.state()).toEqual({
		sessionKey: "k2",
		status: "loading",
		conversation: null,
	});
});

test("a chat that was not loaded is read once when its Pi starts running", async () => {
	const { store, snapshots, answers, texts } = fakeClient();
	answers.runtime = null;
	await store.open(chat.sessionKey, true);
	expect(store.state().status).toBe("not_loaded");
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
	// The turn's first events arrive while that snapshot is on its way.
	store.receive([
		{ ...chat, type: "user_message_start", text: "asked", sequence: 13 },
		{ ...chat, type: "assistant_message_start", sequence: 14 },
	]);
	snapshots[0]?.resolve(snapshot(12));
	await settle();
	store.receive([delta(15, "one")]);

	expect(store.state().status).toBe("ready");
	expect(texts()).toEqual(["saved", "asked", "one"]);
	expect(answers.reads).toBe(2);
	expect(snapshots.length).toBe(1);
});

test("a not loaded chat is read on the first event of a Pi process it had not seen", async () => {
	const { store, snapshots, answers, texts } = fakeClient();
	answers.runtime = null;
	await store.open(chat.sessionKey, true);

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

test("events of a Pi process that gave no transcript do not read the chat again", async () => {
	const { store, snapshots, answers } = fakeClient();
	answers.runtime = stopped;
	await store.open(chat.sessionKey, true);
	expect(answers.reads).toBe(1);

	store.receive([delta(11, "late"), process(12, "stopped"), settled(13)]);
	await settle();
	expect(answers.reads).toBe(1);
	expect(snapshots.length).toBe(0);
	expect(store.state().status).toBe("not_loaded");
});

test("a Pi that is still starting when the chat is read is read again once it runs", async () => {
	const { store, snapshots, answers, texts } = fakeClient();
	answers.runtime = runtime("starting");
	const opened = store.open(chat.sessionKey, true);
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
	const opened = store.open(chat.sessionKey, true);
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
	const opened = store.open(chat.sessionKey, true);
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
	await store.open(chat.sessionKey, false);
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
	const opened = chatStore.open(chat.sessionKey, app.connected);
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
	const opened = chatStore.open(chat.sessionKey, app.connected);
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
	const opened = chatStore.open(chat.sessionKey, app.connected);
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
	await chatStore.open(chat.sessionKey, app.connected);
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
