import { expect, open, test } from "nsh/test";

import type {
	PiloClientEvent,
	PiloClientEventMessage,
	PiloClientEventOptions,
} from "@shared/api/pilo-client";
import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";
import type { Project } from "@shared/api/projects-types";
import type { SessionIndexEntry } from "@shared/api/sessions-types";
import type { PreferencesSnapshot } from "@shared/host-preferences-types";
import type { SessionReadState } from "@shared/session-read-state";
import type { ThemeSettings } from "@shared/theme-settings-types";
import type { NshPiloClientBootstrap } from "../client/nsh-pilo-client";
import {
	AppStore,
	type AppStoreBootstrap,
	type AppStoreClient,
} from "../state/app-store";

const project = (id: string) => ({ id, name: id }) as Project;
const preferences = (revision: number) =>
	({ revision }) as unknown as PreferencesSnapshot;
const theme = (revision: number) => ({ revision }) as ThemeSettings;
const session = (projectId: string, sessionPath: string) =>
	({ projectId, sessionPath }) as SessionIndexEntry;
const read = (
	sessionPath: string,
	completedRevision: number,
	readRevision: number,
): SessionReadState => ({
	projectId: "p1",
	sessionPath,
	completedRevision,
	readRevision,
});
const snapshot = (
	latestSequence: number,
	revision: number,
	...projectIds: string[]
): NshPiloClientBootstrap => ({
	projects: projectIds.map(project),
	chatSessions: [],
	latestSequence,
	preferences: preferences(revision),
});
const events = (
	...items: [sequence: number, body: object][]
): PiloClientEventMessage => ({
	type: "events",
	events: items.map(
		([sequence, body]) => ({ ...body, sequence }) as PiloClientEvent,
	),
});

type Reply<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

/** A client whose calls the test answers, and whose event stream it drives. */
function fakeClient() {
	const listeners = new Set<PiloClientEventOptions>();
	const bootstraps: Reply<AppStoreBootstrap>[] = [];
	const projectLists: Reply<Project[]>[] = [];
	const sessionLists: (Reply<SessionIndexEntry[]> & { projectId: string })[] =
		[];
	const chatStates: (Reply<ChatSessionRuntimeState | null> & {
		sessionKey: string;
	})[] = [];
	const answers = {
		closed: false,
		themeSettings: theme(1) as ThemeSettings | Error,
		readStates: [] as SessionReadState[],
		markFails: false,
		deleteResult: { method: "trash" as const } as
			| { method: "trash" | "unlink" }
			| Error,
	};
	const marked: { projectId: string; sessionPath: string; revision: number }[] =
		[];
	let connections = 0;
	const client: AppStoreClient = {
		get closed() {
			return answers.closed;
		},
		bootstrap: () =>
			new Promise((resolve, reject) => bootstraps.push({ resolve, reject })),
		chatState: (sessionKey) =>
			new Promise((resolve, reject) =>
				chatStates.push({ sessionKey, resolve, reject }),
			),
		listProjects: () =>
			new Promise((resolve, reject) => projectLists.push({ resolve, reject })),
		listSessions: (projectId) =>
			new Promise((resolve, reject) =>
				sessionLists.push({ projectId, resolve, reject }),
			),
		removeProject: () => Promise.resolve([]),
		addProject: () => Promise.reject(new Error("not scripted")),
		loadSessionReadStates: () => Promise.resolve(answers.readStates),
		markSessionRead(projectId, sessionPath, revision) {
			marked.push({ projectId, sessionPath, revision });
			return answers.markFails
				? Promise.reject(new Error("read state was not saved"))
				: Promise.resolve(read(sessionPath, revision, revision));
		},
		updateSessionUiState: () => Promise.reject(new Error("unused")),
		archiveSession: () => Promise.reject(new Error("unused")),
		unarchiveSession: () => Promise.reject(new Error("unused")),
		deleteSession: () =>
			answers.deleteResult instanceof Error
				? Promise.reject(answers.deleteResult)
				: Promise.resolve(answers.deleteResult),
		loadThemeSettings: () =>
			answers.themeSettings instanceof Error
				? Promise.reject(answers.themeSettings)
				: Promise.resolve(answers.themeSettings),
		connectEvents(options) {
			connections += 1;
			if (answers.closed) {
				options.onStatus(false);
				return Promise.resolve(() => {});
			}
			listeners.add(options);
			options.onStatus(true);
			return Promise.resolve(() => {
				if (listeners.delete(options)) options.onStatus(false);
			});
		},
	};
	return {
		client,
		answers,
		bootstraps,
		projectLists,
		sessionLists,
		chatStates,
		marked,
		connections: () => connections,
		listening: () => listeners.size,
		emit(message: PiloClientEventMessage) {
			for (const listener of [...listeners]) listener.onMessage(message);
		},
		/** Ends the stream the way a failed poll or a shutdown does. */
		drop() {
			const dropped = [...listeners];
			listeners.clear();
			for (const listener of dropped) listener.onStatus(false);
		},
	};
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A store that finished its first bootstrap at sequence 10 with p1 and p2. */
async function startedStore() {
	const fake = fakeClient();
	const store = new AppStore(fake.client);
	const started = store.start();
	await settle();
	fake.bootstraps[0]?.resolve(snapshot(10, 3, "p1", "p2"));
	await started;
	return { ...fake, store };
}

test("start shows the first snapshot once every load has answered", async () => {
	const fake = fakeClient();
	fake.answers.readStates = [read("a", 2, 1)];
	const store = new AppStore(fake.client);
	const started = store.start();
	await settle();
	expect(store.state().status).toEqual({ type: "starting" });
	expect(fake.bootstraps.length).toBe(1);

	fake.bootstraps[0]?.resolve(snapshot(10, 3, "p1"));
	await started;
	const state = store.state();
	expect(state.status).toEqual({ type: "ready" });
	expect(state.latestSequence).toBe(10);
	expect(state.projects).toEqual([project("p1")]);
	expect(state.preferences).toEqual(preferences(3));
	expect(state.themeSettings).toEqual(theme(1));
	expect(Object.values(state.readStates)).toEqual([read("a", 2, 1)]);
});

test("a bootstrap with UI state does not fetch theme or read states again", async () => {
	const fake = fakeClient();
	const separateReads: string[] = [];
	fake.client.loadThemeSettings = async () => {
		separateReads.push("theme");
		return theme(1);
	};
	fake.client.loadSessionReadStates = async () => {
		separateReads.push("read states");
		return [];
	};
	const store = new AppStore(fake.client);
	const started = store.start();
	await settle();
	const readState = read("a", 2, 1);
	fake.bootstraps[0]?.resolve({
		...snapshot(10, 3, "p1"),
		uiState: { themeSettings: theme(2), sessionReadStates: [readState] },
	});
	await started;
	expect(store.state().status).toEqual({ type: "ready" });
	expect(store.state().themeSettings).toEqual(theme(2));
	expect(Object.values(store.state().readStates)).toEqual([readState]);
	expect(separateReads).toEqual([]);
});

test("a data directory with no projects is ready and empty", async () => {
	const fake = fakeClient();
	const store = new AppStore(fake.client);
	const started = store.start();
	await settle();
	fake.bootstraps[0]?.resolve(snapshot(0, 0));
	await started;
	expect(store.state().status).toEqual({ type: "ready" });
	expect(store.state().projects).toEqual([]);
	expect(store.state().sessionIndexes).toEqual({});
});

test("a failed load reports its message and retry recovers", async () => {
	const fake = fakeClient();
	const store = new AppStore(fake.client);
	const started = store.start();
	await settle();
	fake.bootstraps[0]?.reject(new Error("database is locked"));
	await started;
	expect(store.state().status).toEqual({
		type: "failed",
		message: "database is locked",
	});

	// A load after the bootstrap fails: nothing of that snapshot is shown.
	fake.answers.themeSettings = new Error("theme file is corrupt");
	const failedAgain = store.retry();
	await settle();
	fake.bootstraps[1]?.resolve(snapshot(10, 3, "p1"));
	await failedAgain;
	expect(store.state().status).toEqual({
		type: "failed",
		message: "theme file is corrupt",
	});
	expect(store.state().projects).toEqual([]);

	fake.answers.themeSettings = theme(1);
	const retried = store.retry();
	await settle();
	fake.bootstraps[2]?.resolve(snapshot(10, 3, "p1"));
	await retried;
	expect(store.state().status).toEqual({ type: "ready" });
	expect(store.state().projects).toEqual([project("p1")]);
	expect(fake.connections()).toBe(1);
});

test("events move the state and reload what they name", async () => {
	const { store, emit, projectLists, sessionLists } = await startedStore();
	void store.loadSessions("p1");
	sessionLists[0]?.resolve([session("p1", "a")]);
	await settle();

	emit(
		events(
			[11, { type: "preferences_changed", settings: preferences(4) }],
			[12, { type: "theme_settings_changed", settings: theme(2) }],
			[13, { type: "session_read_state_changed", state: read("a", 1, 0) }],
			[14, { type: "configuration_changed" }],
			[15, { type: "sessions_indexed", projectId: "p1" }],
			// p2's sessions were never asked for, so they are not loaded now.
			[16, { type: "sessions_indexed", projectId: "p2" }],
		),
	);
	const state = store.state();
	expect(state.preferences?.revision).toBe(4);
	expect(state.themeSettings?.revision).toBe(2);
	expect(Object.values(state.readStates)).toEqual([read("a", 1, 0)]);
	expect(projectLists.length).toBe(1);
	expect(sessionLists.map(({ projectId }) => projectId)).toEqual(["p1", "p1"]);
	expect(state.sessionIndexes.p1).toEqual({
		status: "loaded",
		sessions: [session("p1", "a")],
	});

	projectLists[0]?.resolve([project("p1"), project("p3")]);
	sessionLists[1]?.resolve([session("p1", "a"), session("p1", "b")]);
	await settle();
	expect(store.state().projects).toEqual([project("p1"), project("p3")]);
	expect(store.state().sessionIndexes.p1).toEqual({
		status: "loaded",
		sessions: [session("p1", "a"), session("p1", "b")],
	});
});

test("a gap bootstraps again and events during the resync wait for it", async () => {
	const { store, emit, bootstraps, projectLists, sessionLists } =
		await startedStore();
	void store.loadSessions("p1");
	sessionLists[0]?.resolve([session("p1", "a")]);
	await settle();

	emit({ type: "resyncRequired", latestSequence: 13 });
	// The snapshot of the resync will be cut at 15, between these events.
	emit(
		events(
			[14, { type: "configuration_changed" }],
			[15, { type: "preferences_changed", settings: preferences(5) }],
			[16, { type: "preferences_changed", settings: preferences(7) }],
			[17, { type: "configuration_changed" }],
		),
	);
	await settle();
	expect(bootstraps.length).toBe(2);
	expect(store.state().preferences?.revision).toBe(3);
	expect(store.state().latestSequence).toBe(10);
	expect(projectLists.length).toBe(0);

	bootstraps[1]?.resolve(snapshot(15, 6, "p1", "p2"));
	await settle();
	const state = store.state();
	expect(state.status).toEqual({ type: "ready" });
	expect(state.latestSequence).toBe(15);
	// 15 was skipped as part of the snapshot (revision 6); 16 was applied.
	expect(state.preferences?.revision).toBe(7);
	// Only the configuration change after the cut reloads the projects.
	expect(projectLists.length).toBe(1);
	// The session list refreshes without going back to the loading state.
	expect(sessionLists.map(({ projectId }) => projectId)).toEqual(["p1", "p1"]);
	expect(state.sessionIndexes.p1).toEqual({
		status: "loaded",
		sessions: [session("p1", "a")],
	});

	// Later events are applied directly again.
	emit(events([18, { type: "preferences_changed", settings: preferences(8) }]));
	expect(store.state().preferences?.revision).toBe(8);
});

test("gaps during a resync run one more bootstrap, never two at once", async () => {
	const { store, emit, bootstraps } = await startedStore();
	emit({ type: "resyncRequired", latestSequence: 13 });
	emit({ type: "resyncRequired", latestSequence: 20 });
	emit({ type: "resyncRequired", latestSequence: 30 });
	await settle();
	expect(bootstraps.length).toBe(2);

	bootstraps[1]?.resolve(snapshot(25, 4, "p1"));
	await settle();
	expect(bootstraps.length).toBe(3);
	// The superseded snapshot is shown, but queued events still wait.
	emit(events([32, { type: "preferences_changed", settings: preferences(9) }]));
	expect(store.state().preferences?.revision).toBe(4);

	bootstraps[2]?.resolve(snapshot(31, 5, "p1"));
	await settle();
	expect(bootstraps.length).toBe(3);
	expect(store.state().latestSequence).toBe(31);
	expect(store.state().preferences?.revision).toBe(9);
});

test("a project reload that a resync overtakes is dropped", async () => {
	const { store, emit, bootstraps, projectLists } = await startedStore();
	emit(events([11, { type: "configuration_changed" }]));
	emit({ type: "resyncRequired", latestSequence: 12 });
	await settle();
	bootstraps[1]?.resolve(snapshot(13, 3, "p1", "p4"));
	await settle();
	projectLists[0]?.resolve([project("p1")]);
	await settle();
	expect(store.state().projects).toEqual([project("p1"), project("p4")]);
});

test("a failed project reload is reported and retry recovers", async () => {
	const { store, emit, bootstraps, projectLists } = await startedStore();
	emit(events([11, { type: "configuration_changed" }]));
	projectLists[0]?.reject(new Error("database is locked"));
	await settle();
	expect(store.state().status).toEqual({
		type: "failed",
		message: "database is locked",
	});

	const retried = store.retry();
	await settle();
	bootstraps[1]?.resolve(snapshot(11, 3, "p1"));
	await retried;
	expect(store.state().status).toEqual({ type: "ready" });
});

test("session lists load on demand, keep entries on failure and drop superseded loads", async () => {
	const { store, sessionLists } = await startedStore();
	const first = store.loadSessions("p1");
	expect(store.state().sessionIndexes).toEqual({
		p1: { status: "loading", sessions: [] },
	});
	sessionLists[0]?.resolve([session("p1", "a")]);
	await first;
	expect(store.state().sessionIndexes.p1).toEqual({
		status: "loaded",
		sessions: [session("p1", "a")],
	});

	const failed = store.loadSessions("p1");
	sessionLists[1]?.reject(new Error("Project 'p1' was not found"));
	await failed;
	expect(store.state().sessionIndexes.p1).toEqual({
		status: "failed",
		sessions: [session("p1", "a")],
		message: "Project 'p1' was not found",
	});

	// The older of two loads answers last and must not win.
	const older = store.loadSessions("p1");
	const newer = store.loadSessions("p1");
	sessionLists[3]?.resolve([session("p1", "new")]);
	sessionLists[2]?.resolve([session("p1", "old")]);
	await Promise.all([older, newer]);
	expect(store.state().sessionIndexes.p1).toEqual({
		status: "loaded",
		sessions: [session("p1", "new")],
	});
});

test("a stream that drops after a sync reconnects and bootstraps again", async () => {
	const fake = await startedStore();
	fake.drop();
	await settle();
	expect(fake.connections()).toBe(2);
	expect(fake.bootstraps.length).toBe(2);
	expect(fake.store.state().status).toEqual({ type: "ready" });

	fake.bootstraps[1]?.resolve(snapshot(20, 5, "p1"));
	await settle();
	expect(fake.store.state().latestSequence).toBe(20);
	expect(fake.store.state().preferences?.revision).toBe(5);
	fake.emit(
		events([21, { type: "preferences_changed", settings: preferences(6) }]),
	);
	expect(fake.store.state().preferences?.revision).toBe(6);
});

test("a stream that keeps dropping stops at failed until retry", async () => {
	const fake = await startedStore();
	fake.drop();
	await settle();
	// The reconnected stream drops before its bootstrap answers.
	fake.drop();
	await settle();
	expect(fake.connections()).toBe(2);
	expect(fake.listening()).toBe(0);
	expect(fake.store.state().status).toEqual({
		type: "failed",
		message: "The runtime event stream stopped.",
	});

	// The bootstrap of the stream that dropped answers late and is not shown.
	fake.bootstraps[1]?.resolve(snapshot(20, 5, "p1"));
	await settle();
	expect(fake.store.state().status.type).toBe("failed");
	expect(fake.store.state().latestSequence).toBe(10);

	const retried = fake.store.retry();
	await settle();
	expect(fake.connections()).toBe(3);
	fake.bootstraps[2]?.resolve(snapshot(21, 5, "p1"));
	await retried;
	expect(fake.store.state().status).toEqual({ type: "ready" });
	expect(fake.store.state().latestSequence).toBe(21);
});

test("a poll that fails after each finished load resumes once, then waits for retry", async () => {
	const fake = await startedStore();
	fake.drop();
	await settle();
	fake.bootstraps[1]?.resolve(snapshot(20, 5, "p1"));
	await settle();
	expect(fake.store.state().status).toEqual({ type: "ready" });
	expect(fake.connections()).toBe(2);

	// The resumed stream loaded, then fails again without one event.
	fake.drop();
	await settle();
	expect(fake.connections()).toBe(2);
	expect(fake.bootstraps.length).toBe(2);
	expect(fake.listening()).toBe(0);
	expect(fake.store.state().status).toEqual({
		type: "failed",
		message: "The runtime event stream stopped.",
	});

	const retried = fake.store.retry();
	await settle();
	fake.bootstraps[2]?.resolve(snapshot(21, 5, "p1"));
	await retried;
	expect(fake.connections()).toBe(3);
	expect(fake.store.state().status).toEqual({ type: "ready" });
});

test("a resumed stream that delivers an event may be resumed again", async () => {
	const fake = await startedStore();
	fake.drop();
	await settle();
	fake.bootstraps[1]?.resolve(snapshot(20, 5, "p1"));
	await settle();
	fake.emit(
		events([21, { type: "preferences_changed", settings: preferences(6) }]),
	);

	fake.drop();
	await settle();
	expect(fake.connections()).toBe(3);
	expect(fake.bootstraps.length).toBe(3);
	fake.bootstraps[2]?.resolve(snapshot(22, 6, "p1"));
	await settle();
	expect(fake.store.state().status).toEqual({ type: "ready" });
	expect(fake.store.state().latestSequence).toBe(22);
});

test("a runtime shutdown closes the state and is not reconnected", async () => {
	const fake = await startedStore();
	fake.answers.closed = true;
	fake.drop();
	await settle();
	expect(fake.store.state().status).toEqual({ type: "closed" });
	expect(fake.connections()).toBe(1);
	expect(fake.bootstraps.length).toBe(1);

	// Starting on a client that is already closed reports it as well.
	const late = new AppStore(fake.client);
	await late.start();
	expect(late.state().status).toEqual({ type: "closed" });
	expect(fake.bootstraps.length).toBe(1);
});

test("stop ends listening and a load in flight is not shown", async () => {
	const fake = await startedStore();
	fake.emit({ type: "resyncRequired", latestSequence: 12 });
	await settle();
	fake.store.stop();
	expect(fake.listening()).toBe(0);
	fake.bootstraps[1]?.resolve(snapshot(20, 5, "p1"));
	await settle();
	expect(fake.connections()).toBe(1);
	expect(fake.store.state().status).toEqual({ type: "ready" });
	expect(fake.store.state().latestSequence).toBe(10);
	expect(fake.store.state().preferences?.revision).toBe(3);

	// Starting again connects and loads afresh.
	const restarted = fake.store.start();
	await settle();
	fake.bootstraps[2]?.resolve(snapshot(21, 6, "p1"));
	await restarted;
	expect(fake.connections()).toBe(2);
	expect(fake.store.state().latestSequence).toBe(21);
});

test("opening an unread session acknowledges its completed turns once", async () => {
	const fake = fakeClient();
	fake.answers.readStates = [read("unread", 3, 1), read("seen", 2, 2)];
	const store = new AppStore(fake.client);
	const started = store.start();
	await settle();
	fake.bootstraps[0]?.resolve(snapshot(10, 3, "p1", "p2"));
	await started;

	store.selectSession("p1", "seen");
	store.selectSession("p1", "never-completed");
	store.selectSession("gone", "unread");
	expect(fake.marked).toEqual([]);
	expect(store.state().navigation.session?.sessionPath).toBe("never-completed");

	store.selectSession("p1", "unread");
	expect(fake.marked).toEqual([
		{ projectId: "p1", sessionPath: "unread", revision: 3 },
	]);
	// The runtime's event, not the reply, moves the state.
	fake.emit(
		events([
			11,
			{ type: "session_read_state_changed", state: read("unread", 3, 3) },
		]),
	);
	store.selectSession("p1", "unread");
	expect(fake.marked.length).toBe(1);

	store.selectProject("p2");
	const selected = store.state().navigation.session;
	expect(selected?.projectId).toBe("p2");
	expect(selected?.sessionPath).toBeUndefined();
	expect(typeof selected?.sessionId).toBe("string");
});

test("a turn completed in the open session is acknowledged when asked", async () => {
	const fake = fakeClient();
	fake.answers.readStates = [read("open", 3, 3), read("other", 2, 2)];
	const store = new AppStore(fake.client);
	const started = store.start();
	await settle();
	fake.bootstraps[0]?.resolve(snapshot(10, 3, "p1"));
	await started;

	// Nothing is open, and then nothing in the open session is unseen.
	store.acknowledgeOpenSession();
	store.selectSession("p1", "open");
	store.acknowledgeOpenSession();
	expect(fake.marked).toEqual([]);

	// A turn that ends in another session is not the open one's.
	fake.emit(
		events(
			[11, { type: "session_read_state_changed", state: read("other", 3, 2) }],
			[12, { type: "session_read_state_changed", state: read("open", 4, 3) }],
		),
	);
	store.acknowledgeOpenSession();
	expect(fake.marked).toEqual([
		{ projectId: "p1", sessionPath: "open", revision: 4 },
	]);
	expect(store.state().navigation.session?.sessionPath).toBe("open");
});

test("a failed acknowledgment leaves the session open and unread", async () => {
	const fake = fakeClient();
	fake.answers.readStates = [read("unread", 3, 1)];
	fake.answers.markFails = true;
	const store = new AppStore(fake.client);
	const started = store.start();
	await settle();
	fake.bootstraps[0]?.resolve(snapshot(10, 3, "p1"));
	await started;

	store.selectSession("p1", "unread");
	await settle();
	expect(store.state().navigation.session?.sessionPath).toBe("unread");
	expect(Object.values(store.state().readStates)).toEqual([
		read("unread", 3, 1),
	]);
	expect(store.state().status).toEqual({ type: "ready" });
});

test("the state follows the real native module through events, a gap and shutdown", async () => {
	const app = await open("./app-store-fixture.tsx");
	await app.waitFor(
		"text:app state followed the native module through a gap and shutdown",
		{ timeout: 30_000 },
	);
});

const chat = (
	sessionKey: string,
	activeTurn = false,
): ChatSessionRuntimeState => ({
	sessionKey,
	projectId: "p1",
	prepared: true,
	initialized: true,
	activeTurn,
	snapshot: {
		generation: 1,
		state: "running",
		connection: null,
		projectId: "p1",
	},
});
const chatEvent = (sequence: number, sessionKey: string, type: string) =>
	[sequence, { type, sessionKey, projectId: "p1", generation: 1 }] as [
		number,
		object,
	];

test("a chat started after launch appears, follows its turn and goes when stopped", async () => {
	const { store, emit, chatStates } = await startedStore();
	expect(store.state().chatSessions).toEqual([]);

	emit(events(chatEvent(11, "k1", "process_state")));
	await settle();
	expect(chatStates.map(({ sessionKey }) => sessionKey)).toEqual(["k1"]);
	// Nothing is shown from the event itself.
	expect(store.state().chatSessions).toEqual([]);
	chatStates[0]?.resolve(chat("k1"));
	await settle();
	expect(store.state().chatSessions).toEqual([chat("k1")]);

	emit(events(chatEvent(12, "k1", "user_message_start")));
	await settle();
	chatStates[1]?.resolve(chat("k1", true));
	await settle();
	expect(store.state().chatSessions).toEqual([chat("k1", true)]);

	emit(events(chatEvent(13, "k1", "process_state")));
	await settle();
	chatStates[2]?.resolve(null);
	await settle();
	expect(store.state().chatSessions).toEqual([]);
});

test("events during a chat state read cause one more read, however many they are", async () => {
	const { store, emit, chatStates } = await startedStore();
	emit(events(chatEvent(11, "k1", "user_message_start")));
	await settle();
	emit(
		events(
			chatEvent(12, "k1", "assistant_message_start"),
			chatEvent(13, "k1", "assistant_message_end"),
		),
	);
	emit(events(chatEvent(14, "k1", "user_message_start")));
	await settle();
	expect(chatStates.length).toBe(1);

	chatStates[0]?.resolve(chat("k1", true));
	await settle();
	expect(chatStates.length).toBe(2);
	chatStates[1]?.resolve(chat("k1"));
	await settle();
	expect(chatStates.length).toBe(2);
	expect(store.state().chatSessions).toEqual([chat("k1")]);

	// With no read in flight, the next event reads again.
	emit(events(chatEvent(15, "k1", "user_message_start")));
	await settle();
	expect(chatStates.length).toBe(3);
});

test("each chat is read on its own events", async () => {
	const { store, emit, chatStates } = await startedStore();
	emit(
		events(
			chatEvent(11, "k1", "process_state"),
			chatEvent(12, "k2", "process_state"),
			chatEvent(13, "k1", "user_message_start"),
		),
	);
	await settle();
	expect(chatStates.map(({ sessionKey }) => sessionKey)).toEqual(["k1", "k2"]);
	chatStates[1]?.resolve(chat("k2"));
	chatStates[0]?.resolve(chat("k1"));
	await settle();
	chatStates[2]?.resolve(chat("k1", true));
	await settle();

	expect(chatStates.map(({ sessionKey }) => sessionKey)).toEqual([
		"k1",
		"k2",
		"k1",
	]);
	expect(store.state().chatSessions).toEqual([chat("k2"), chat("k1", true)]);
});

test("text and tool events, and events of no chat, read no chat state", async () => {
	const { emit, chatStates } = await startedStore();
	emit(
		events(
			chatEvent(11, "k1", "assistant_text_delta"),
			chatEvent(12, "k1", "tool_execution_start"),
			[13, { type: "process_state", generation: 1 }],
			[14, { type: "sessions_indexed", projectId: "p1" }],
		),
	);
	await settle();
	expect(chatStates.length).toBe(0);
});

test("a chat state that answers after a newer bootstrap is not shown", async () => {
	const { store, emit, chatStates, bootstraps } = await startedStore();
	emit(events(chatEvent(11, "k1", "process_state")));
	await settle();
	emit({ type: "resyncRequired", latestSequence: 20 });
	await settle();
	bootstraps[1]?.resolve({
		...snapshot(20, 3, "p1", "p2"),
		chatSessions: [chat("k1", true)],
	});
	await settle();
	expect(store.state().chatSessions).toEqual([chat("k1", true)]);

	// Read before that bootstrap, so older than what it holds.
	chatStates[0]?.resolve(chat("k1"));
	await settle();
	expect(store.state().chatSessions).toEqual([chat("k1", true)]);
});

test("a chat's events that waited for a bootstrap read its state after it", async () => {
	const { store, emit, chatStates, bootstraps } = await startedStore();
	emit({ type: "resyncRequired", latestSequence: 20 });
	await settle();
	emit(events(chatEvent(21, "k1", "user_message_start")));
	await settle();
	expect(chatStates.length).toBe(0);

	bootstraps[1]?.resolve({
		...snapshot(20, 3, "p1", "p2"),
		chatSessions: [chat("k1")],
	});
	await settle();
	expect(chatStates.length).toBe(1);
	chatStates[0]?.resolve(chat("k1", true));
	await settle();
	expect(store.state().chatSessions).toEqual([chat("k1", true)]);
});

test("a chat state read that fails keeps the state shown and the next event reads again", async () => {
	const { store, emit, chatStates } = await startedStore();
	emit(events(chatEvent(11, "k1", "process_state")));
	await settle();
	chatStates[0]?.resolve(chat("k1"));
	await settle();

	emit(events(chatEvent(12, "k1", "user_message_start")));
	await settle();
	chatStates[1]?.reject(new Error("the runtime did not answer"));
	await settle();
	expect(store.state().chatSessions).toEqual([chat("k1")]);
	expect(store.state().status).toEqual({ type: "ready" });

	emit(events(chatEvent(13, "k1", "assistant_message_start")));
	await settle();
	chatStates[2]?.resolve(chat("k1", true));
	await settle();
	expect(store.state().chatSessions).toEqual([chat("k1", true)]);
});

test("deleteSession returns the deletion method and propagates errors", async () => {
	const { store, answers, sessionLists } = await startedStore();
	const load = store.loadSessions("p1");
	sessionLists[0]?.resolve([session("p1", "a"), session("p1", "b")]);
	await load;

	answers.deleteResult = { method: "trash" };
	expect(await store.deleteSession("p1", "a")).toEqual({
		method: "trash",
	});
	expect(
		store.state().sessionIndexes.p1?.sessions.map((s) => s.sessionPath),
	).toEqual(["b"]);

	answers.deleteResult = new Error("file is busy");
	let failed: unknown;
	await store.deleteSession("p1", "b").catch((error: unknown) => {
		failed = error;
	});
	expect(failed instanceof Error ? failed.message : null).toBe("file is busy");
	expect(
		store.state().sessionIndexes.p1?.sessions.map((s) => s.sessionPath),
	).toEqual(["b"]);
});

test("the store keeps the chat states current through the native module", async () => {
	const app = await open("./app-store-chat-fixture.tsx");
	await app.waitFor("text:chat states followed through the store", {
		timeout: 30_000,
	});
});
