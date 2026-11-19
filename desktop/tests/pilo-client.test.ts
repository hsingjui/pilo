import { expect, open, test } from "nsh/test";

import type {
	PiloClientEventMessage,
	PiloClientEventOptions,
} from "@/lib/api/pilo-client";
import { NshPiloClient, type PiloNative } from "../client/nsh-pilo-client";

type Call = [method: string, ...args: unknown[]];

function fakeNative(overrides: Partial<PiloNative> = {}) {
	const calls: Call[] = [];
	const answer =
		<T>(method: string, value: T) =>
		(...args: unknown[]) => {
			calls.push([method, ...args]);
			return Promise.resolve(value);
		};
	const preferences = { revision: 3, values: { locale: "zh-CN" } };
	const readState = {
		projectId: "p1",
		sessionPath: "/s.jsonl",
		completedRevision: 2,
		readRevision: 1,
	};
	const pilo: PiloNative = {
		bootstrap: answer("bootstrap", {
			eventSequence: 41,
			projects: [{ id: "p1" }],
			chatSessions: [{ sessionKey: "k1" }],
			preferences,
		}),
		nextEvents: answer("nextEvents", { type: "closed" }),
		startChat: answer("startChat", { state: "running", generation: 1 }),
		stopChat: answer("stopChat", undefined),
		chatState: answer("chatState", null),
		sendChatCommand: answer("sendChatCommand", undefined),
		listProjects: answer("listProjects", [{ id: "p1" }]),
		listSessions: answer("listSessions", [{ piSessionId: "s1" }]),
		searchSessions: answer("searchSessions", [{ sessionId: "s1" }]),
		generateSessionTitle: answer("generateSessionTitle", "Repair the parser"),
		deleteSession: answer("deleteSession", { method: "trash" }),
		readHistoryImage: answer("readHistoryImage", new Uint8Array([1, 2])),
		readProjectImage: answer("readProjectImage", new Uint8Array([3])),
		loadConnectionModels: answer("loadConnectionModels", [{ id: "m1" }]),
		loadModels: answer("loadModels", { projectId: "p1", models: [] }),
		loadModelScope: answer("loadModelScope", {
			projectId: "p1",
			models: null,
			updatedAtMs: 0,
		}),
		saveModelScope: answer("saveModelScope", {
			projectId: "p1",
			models: [],
			updatedAtMs: 9,
		}),
		loadSessionReadStates: answer("loadSessionReadStates", [readState]),
		markSessionRead: answer("markSessionRead", readState),
		loadPreferences: answer("loadPreferences", preferences),
		savePreferences: answer("savePreferences", preferences),
		loadThemeSettings: answer("loadThemeSettings", { revision: 7 }),
		saveThemeSettings: answer("saveThemeSettings", { revision: 8 }),
		shutdown: answer("shutdown", undefined),
		...overrides,
	};
	return { pilo, calls, preferences, readState };
}

test("bootstrap carries the native event cut as latestSequence", async () => {
	const { pilo, preferences } = fakeNative();
	expect(await new NshPiloClient(pilo).bootstrap()).toEqual({
		projects: [{ id: "p1" }],
		chatSessions: [{ sessionKey: "k1" }],
		latestSequence: 41,
		preferences,
	});
});

test("data calls pass their arguments to the native module and return its answers", async () => {
	const { pilo, calls, preferences, readState } = fakeNative();
	const client = new NshPiloClient(pilo);

	expect(await client.listProjects()).toEqual([{ id: "p1" }]);
	expect(await client.listSessions("p1")).toEqual([{ piSessionId: "s1" }]);
	expect(await client.loadSessionReadStates()).toEqual([readState]);
	expect(await client.markSessionRead("p1", "/s.jsonl", 2)).toEqual(readState);
	expect(await client.loadPreferences()).toEqual(preferences);
	expect(await client.savePreferences({ locale: "zh-CN" })).toEqual(
		preferences,
	);
	expect(await client.loadThemeSettings()).toEqual({ revision: 7 });
	expect(await client.saveThemeSettings({ theme: "dark" })).toEqual({
		revision: 8,
	});
	await client.shutdown();

	expect(calls).toEqual([
		["listProjects"],
		["listSessions", "p1"],
		["loadSessionReadStates"],
		["markSessionRead", "p1", "/s.jsonl", 2],
		["loadPreferences"],
		["savePreferences", { locale: "zh-CN" }],
		["loadThemeSettings"],
		["saveThemeSettings", { theme: "dark" }],
		["shutdown"],
	]);
});

test("a native rejection reaches the caller unchanged", async () => {
	const failure = new Error("Project 'missing' was not found");
	const { pilo } = fakeNative({
		listSessions: () => Promise.reject(failure),
	});
	let caught: unknown;
	try {
		await new NshPiloClient(pilo).listSessions("missing");
	} catch (error) {
		caught = error;
	}
	expect(caught).toBe(failure);
});

test("chat calls pass their arguments to the native module and return its answers", async () => {
	const state = { sessionKey: "k1", activeTurn: false };
	const { pilo, calls } = fakeNative({
		chatState: (sessionKey) =>
			Promise.resolve(sessionKey === "k1" ? state : null),
	});
	const client = new NshPiloClient(pilo);
	const input = {
		projectId: "p1",
		sessionKey: "k1",
		sessionPath: "/sessions/a.jsonl",
		noSession: false,
		builtinExtensions: [{ id: "model-catalog" as const }],
	};

	expect(await client.startChat(input)).toEqual({
		state: "running",
		generation: 1,
	});
	expect(await client.chatState("k1")).toBe(state);
	expect(await client.chatState("absent")).toBe(null);
	await client.sendChatCommand("k1", { id: "c1", type: "get_state" });
	await client.stopChat("k1", "user closed the chat");
	await client.stopChat("k1");

	expect(calls).toEqual([
		["startChat", input],
		["sendChatCommand", "k1", { id: "c1", type: "get_state" }],
		["stopChat", "k1", "user closed the chat"],
		["stopChat", "k1", undefined],
	]);
});

test("a chat call the native module rejects reaches the caller unchanged", async () => {
	const failure = new Error("Chat session 'k1' is not running");
	const { pilo } = fakeNative({
		startChat: () => Promise.reject(failure),
		sendChatCommand: () => Promise.reject(failure),
	});
	const client = new NshPiloClient(pilo);
	for (const call of [
		client.startChat({ projectId: "p1", sessionKey: "k1" }),
		client.sendChatCommand("k1", { type: "prompt" }),
	]) {
		let caught: unknown;
		await call.catch((error: unknown) => {
			caught = error;
		});
		expect(caught).toBe(failure);
	}
});

test("session search, title and deletion pass their arguments and return the native answers", async () => {
	const { pilo, calls } = fakeNative();
	const client = new NshPiloClient(pilo);

	expect(await client.searchSessions("p1", "needle", 5)).toEqual([
		{ sessionId: "s1" },
	]);
	expect(await client.searchSessions("p1", "needle")).toEqual([
		{ sessionId: "s1" },
	]);
	expect(await client.generateSessionTitle("p1", "Repair the parser")).toBe(
		"Repair the parser",
	);
	expect(await client.deleteSession("p1", "/s.jsonl")).toEqual({
		method: "trash",
	});
	expect(calls).toEqual([
		["searchSessions", "p1", "needle", 5],
		["searchSessions", "p1", "needle", undefined],
		["generateSessionTitle", "p1", "Repair the parser"],
		["deleteSession", "p1", "/s.jsonl"],
	]);
});

test("no matches, no naming model and a rejected deletion reach the caller as they are", async () => {
	const failure = new Error("Session '/s.jsonl' is not indexed");
	const { pilo } = fakeNative({
		searchSessions: () => Promise.resolve([]),
		generateSessionTitle: () => Promise.resolve(null),
		deleteSession: () => Promise.reject(failure),
	});
	const client = new NshPiloClient(pilo);

	expect(await client.searchSessions("p1", "no match")).toEqual([]);
	expect(await client.generateSessionTitle("p1", "hello")).toBe(null);
	let caught: unknown;
	await client.deleteSession("p1", "/s.jsonl").catch((error: unknown) => {
		caught = error;
	});
	expect(caught).toBe(failure);
});

test("image reads pass their arguments and return the native bytes", async () => {
	const { pilo, calls } = fakeNative();
	const client = new NshPiloClient(pilo);
	const fingerprint = { fileSize: 12, fileMtimeNs: "1735787045000000000" };

	expect(
		await client.readHistoryImage("p1", "/s.jsonl", "m1:0", fingerprint),
	).toEqual(new Uint8Array([1, 2]));
	expect(await client.readHistoryImage("p1", "/s.jsonl", "m1:0")).toEqual(
		new Uint8Array([1, 2]),
	);
	expect(await client.readProjectImage("p1", "docs/a.png")).toEqual(
		new Uint8Array([3]),
	);
	expect(calls).toEqual([
		["readHistoryImage", "p1", "/s.jsonl", "m1:0", fingerprint],
		["readHistoryImage", "p1", "/s.jsonl", "m1:0", undefined],
		["readProjectImage", "p1", "docs/a.png"],
	]);
});

test("an image the native module cannot read rejects with its error", async () => {
	const failure = new Error("image 'm1:0' was not found");
	const { pilo } = fakeNative({
		readHistoryImage: () => Promise.reject(failure),
		readProjectImage: () => Promise.reject(failure),
	});
	const client = new NshPiloClient(pilo);
	for (const call of [
		client.readHistoryImage("p1", "/s.jsonl", "m1:0"),
		client.readProjectImage("p1", "docs/a.png"),
	]) {
		let caught: unknown;
		await call.catch((error: unknown) => {
			caught = error;
		});
		expect(caught).toBe(failure);
	}
});

test("model calls pass their arguments and return the native answers", async () => {
	const { pilo, calls } = fakeNative();
	const client = new NshPiloClient(pilo);

	expect(await client.loadConnectionModels("local")).toEqual([{ id: "m1" }]);
	expect(await client.loadModels("p1")).toEqual({
		projectId: "p1",
		models: [],
	});
	expect(await client.loadModelScope("p1")).toEqual({
		projectId: "p1",
		models: null,
		updatedAtMs: 0,
	});
	expect(calls).toEqual([
		["loadConnectionModels", "local"],
		["loadModels", "p1"],
		["loadModelScope", "p1"],
	]);
});

test("an uncached catalog is null and a rejected model call keeps its error", async () => {
	const failure = new Error("Connection 'gone' was not found");
	const { pilo } = fakeNative({
		loadConnectionModels: () => Promise.reject(failure),
		loadModels: () => Promise.resolve(null),
		loadModelScope: () => Promise.reject(failure),
	});
	const client = new NshPiloClient(pilo);

	expect(await client.loadModels("p1")).toBe(null);
	for (const call of [
		client.loadConnectionModels("gone"),
		client.loadModelScope("gone"),
	]) {
		let caught: unknown;
		await call.catch((error: unknown) => {
			caught = error;
		});
		expect(caught).toBe(failure);
	}
});

test("saving a model scope passes the list, an empty list or null and returns the saved scope", async () => {
	const { pilo, calls } = fakeNative();
	const client = new NshPiloClient(pilo);
	const models = [
		{ provider: "relay", modelId: "m1", thinkingLevel: "high" as const },
		{ provider: "relay", modelId: "m2", thinkingLevel: null, isDefault: true },
	];

	expect(await client.saveModelScope("p1", models)).toEqual({
		projectId: "p1",
		models: [],
		updatedAtMs: 9,
	});
	await client.saveModelScope("p1", []);
	await client.saveModelScope("p1", null);
	expect(calls).toEqual([
		["saveModelScope", "p1", models],
		["saveModelScope", "p1", []],
		["saveModelScope", "p1", null],
	]);
});

test("a model scope the native module refuses rejects with its error", async () => {
	const failure = new Error("model scope can contain only one default model");
	const { pilo } = fakeNative({
		saveModelScope: () => Promise.reject(failure),
	});
	let caught: unknown;
	await new NshPiloClient(pilo)
		.saveModelScope("p1", [])
		.catch((error: unknown) => {
			caught = error;
		});
	expect(caught).toBe(failure);
});

/** A native event stream whose polls the test answers one at a time. */
function fakeEventStream() {
	const polls: {
		max: number;
		resolve: (batch: unknown) => void;
		reject: (error: Error) => void;
	}[] = [];
	const { pilo } = fakeNative({
		nextEvents: (max) =>
			new Promise((resolve, reject) => polls.push({ max, resolve, reject })),
	});
	return { client: new NshPiloClient(pilo), polls };
}

function listener() {
	const messages: PiloClientEventMessage[] = [];
	const statuses: boolean[] = [];
	const options: PiloClientEventOptions = {
		onMessage: (message) => messages.push(message),
		onStatus: (connected) => statuses.push(connected),
	};
	return { options, messages, statuses };
}

function events(...sequences: number[]) {
	return {
		type: "events",
		events: sequences.map((sequence) => ({
			type: "assistant_text_delta",
			generation: 1,
			delta: String(sequence),
			sequence,
		})),
	};
}

/** Lets the client's poll loop run up to its next native call. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("event batches reach every listener in order with one poll in flight", async () => {
	const { client, polls } = fakeEventStream();
	const first = listener();
	const second = listener();
	await client.connectEvents(first.options);
	await client.connectEvents(second.options);
	await settle();

	expect(first.statuses).toEqual([true]);
	expect(polls.length).toBe(1);
	expect(Number.isSafeInteger(polls[0]?.max) && (polls[0]?.max ?? 0) > 0).toBe(
		true,
	);

	polls[0]?.resolve(events(1, 2));
	await settle();
	expect(polls.length).toBe(2);
	polls[1]?.resolve(events(3));
	await settle();

	expect(first.messages).toEqual([events(1, 2), events(3)]);
	expect(second.messages).toEqual(first.messages);
	expect(polls.length).toBe(3);
});

test("a gap asks listeners to resync and polling continues on the same stream", async () => {
	const { client, polls } = fakeEventStream();
	const { options, messages, statuses } = listener();
	await client.connectEvents(options);
	await settle();

	polls[0]?.resolve({ type: "gap", firstMissed: 5, lastMissed: 9 });
	await settle();
	polls[1]?.resolve(events(10));
	await settle();

	expect(messages).toEqual([
		{ type: "resyncRequired", latestSequence: 9 },
		events(10),
	]);
	expect(statuses).toEqual([true]);
});

test("a closed stream disconnects listeners and is never polled again", async () => {
	const { client, polls } = fakeEventStream();
	const { options, messages, statuses } = listener();
	await client.connectEvents(options);
	await settle();
	polls[0]?.resolve({ type: "closed" });
	await settle();

	expect(statuses).toEqual([true, false]);
	expect(messages).toEqual([]);
	expect(client.closed).toBe(true);

	const late = listener();
	const disconnect = await client.connectEvents(late.options);
	await settle();
	disconnect();
	expect(late.statuses).toEqual([false]);
	expect(polls.length).toBe(1);
});

test("a batch that arrives after the last listener left waits for the next one", async () => {
	const { client, polls } = fakeEventStream();
	const gone = listener();
	const disconnect = await client.connectEvents(gone.options);
	await settle();
	disconnect();
	disconnect();
	expect(gone.statuses).toEqual([true, false]);

	polls[0]?.resolve(events(1));
	await settle();
	expect(gone.messages).toEqual([]);
	expect(polls.length).toBe(1);

	const next = listener();
	await client.connectEvents(next.options);
	await settle();
	expect(next.messages).toEqual([events(1)]);
	expect(polls.length).toBe(2);
});

test("a failed poll disconnects listeners and reconnecting resumes polling", async () => {
	const { client, polls } = fakeEventStream();
	const failed = listener();
	await client.connectEvents(failed.options);
	await settle();
	polls[0]?.reject(new Error("bridge failure"));
	await settle();

	expect(failed.statuses).toEqual([true, false]);
	expect(polls.length).toBe(1);
	expect(client.closed).toBe(false);

	const resumed = listener();
	await client.connectEvents(resumed.options);
	await settle();
	polls[1]?.resolve(events(4));
	await settle();
	expect(resumed.messages).toEqual([events(4)]);
	expect(failed.messages).toEqual([]);
});

test("a listener that throws does not stop delivery to the others", async () => {
	const { client, polls } = fakeEventStream();
	const healthy = listener();
	await client.connectEvents({
		onMessage: () => {
			throw new Error("listener failure");
		},
		onStatus: () => {},
	});
	await client.connectEvents(healthy.options);
	await settle();
	polls[0]?.resolve(events(1));
	await settle();
	polls[1]?.resolve(events(2));
	await settle();

	expect(healthy.messages).toEqual([events(1), events(2)]);
	expect(healthy.statuses).toEqual([true]);
});

test("the client reads and writes Host data through the native module", async () => {
	const app = await open("./pilo-client-fixture.tsx");
	await app.waitFor(
		"text:client data calls verified against the native module",
	);
});

test("the client delivers native runtime events, a queue overflow gap and shutdown", async () => {
	const app = await open("./pilo-client-events-fixture.tsx");
	await app.waitFor(
		"text:client event delivery, gap resync and shutdown verified",
		{ timeout: 20_000 },
	);
});

test("the client starts, queries, commands and stops a Pi chat through the native module", async () => {
	const app = await open("./pilo-client-chat-fixture.tsx");
	await app.waitFor("text:client chat lifecycle and command reply verified", {
		timeout: 30_000,
	});
});

test("the client searches, deletes and titles sessions through the native module", async () => {
	const app = await open("./pilo-client-sessions-fixture.tsx");
	await app.waitFor("text:client session search, deletion and title verified", {
		timeout: 30_000,
	});
});

test("the client reads project and session image bytes through the native module", async () => {
	const app = await open("./pilo-client-images-fixture.tsx");
	await app.waitFor("text:client project and session image bytes verified", {
		timeout: 30_000,
	});
});

test("the client loads connection models and a saved catalog, and loads and saves a model scope through the native module", async () => {
	const app = await open("./pilo-client-models-fixture.tsx");
	await app.waitFor("text:client model catalogs and scope saves verified", {
		timeout: 30_000,
	});
});
