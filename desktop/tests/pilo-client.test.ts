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
		chatTranscriptSnapshot: answer("chatTranscriptSnapshot", {
			eventSequence: 12,
			sessionKey: "k1",
			generation: 1,
			live: { type: "idle" },
		}),
		sendChatCommand: answer("sendChatCommand", undefined),
		listProjects: answer("listProjects", [{ id: "p1" }]),
		listSessions: answer("listSessions", [{ piSessionId: "s1" }]),
		searchSessions: answer("searchSessions", [{ sessionId: "s1" }]),
		searchProjectFiles: answer("searchProjectFiles", ["src/main.ts"]),
		uploadChatFile: answer("uploadChatFile", "/attachments/aQ/note.md"),
		removeChatFile: answer("removeChatFile", undefined),
		generateSessionTitle: answer("generateSessionTitle", "Repair the parser"),
		deleteSession: answer("deleteSession", { method: "trash" }),
		loadHistory: answer("loadHistory", {
			history: { totalMessages: 2 },
			fingerprint: { fileSize: 9, fileMtimeNs: "7" },
		}),
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
		loadCacheKeepAliveSettings: answer("loadCacheKeepAliveSettings", []),
		saveCacheKeepAliveSettings: answer("saveCacheKeepAliveSettings", {
			modelId: "m1",
			updatedAtMs: 9,
		}),
		loadNextPromptSettings: answer("loadNextPromptSettings", {
			connectionId: "local",
			enabled: false,
			model: null,
			updatedAtMs: 0,
		}),
		saveNextPromptSettings: answer("saveNextPromptSettings", {
			connectionId: "local",
			enabled: true,
			updatedAtMs: 9,
		}),
		requestNextPrompt: answer("requestNextPrompt", undefined),
		loadPromptEnhancementSettings: answer("loadPromptEnhancementSettings", {
			connectionId: "local",
			enabled: false,
			model: null,
			updatedAtMs: 0,
		}),
		enhancePrompt: answer("enhancePrompt", "Fix the parser's unit test."),
		savePromptEnhancementSettings: answer("savePromptEnhancementSettings", {
			connectionId: "local",
			enabled: true,
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
	expect(await client.searchProjectFiles("p1", "ma")).toEqual(["src/main.ts"]);
	expect(
		await client.uploadChatFile("p1", "note.md", new Uint8Array([1, 2])),
	).toBe("/attachments/aQ/note.md");
	await client.removeChatFile("p1", "/attachments/aQ/note.md");
	expect(await client.generateSessionTitle("p1", "Repair the parser")).toBe(
		"Repair the parser",
	);
	expect(await client.deleteSession("p1", "/s.jsonl")).toEqual({
		method: "trash",
	});
	expect(calls).toEqual([
		["searchSessions", "p1", "needle", 5],
		["searchSessions", "p1", "needle", undefined],
		["searchProjectFiles", "p1", "ma"],
		["uploadChatFile", "p1", "note.md", new Uint8Array([1, 2])],
		["removeChatFile", "p1", "/attachments/aQ/note.md"],
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

test("cache keep-alive calls pass their arguments and return the native answers", async () => {
	const policy = {
		connectionId: "local",
		provider: "relay",
		modelId: "m1",
		enabled: true,
		cacheTtlSeconds: 300,
		idleKeepAliveSeconds: 1800,
		updatedAtMs: 0,
	};
	const { pilo, calls } = fakeNative({
		loadCacheKeepAliveSettings: (connectionId) =>
			Promise.resolve(connectionId === "local" ? [policy] : []),
	});
	const client = new NshPiloClient(pilo);

	expect(await client.loadCacheKeepAliveSettings("local")).toEqual([policy]);
	expect(await client.loadCacheKeepAliveSettings("other")).toEqual([]);
	expect(await client.saveCacheKeepAliveSettings(policy)).toEqual({
		modelId: "m1",
		updatedAtMs: 9,
	});
	expect(calls).toEqual([["saveCacheKeepAliveSettings", policy]]);
});

test("a cache keep-alive policy the native module refuses rejects with its error", async () => {
	const failure = new Error("invalid cache keep-alive settings");
	const { pilo } = fakeNative({
		loadCacheKeepAliveSettings: () => Promise.reject(failure),
		saveCacheKeepAliveSettings: () => Promise.reject(failure),
	});
	const client = new NshPiloClient(pilo);
	for (const call of [
		client.loadCacheKeepAliveSettings("gone"),
		client.saveCacheKeepAliveSettings({
			connectionId: "local",
			provider: "relay",
			modelId: "m1",
			enabled: true,
			cacheTtlSeconds: 1,
			idleKeepAliveSeconds: 1,
			updatedAtMs: 0,
		}),
	]) {
		let caught: unknown;
		await call.catch((error: unknown) => {
			caught = error;
		});
		expect(caught).toBe(failure);
	}
});

test("next-prompt calls pass their arguments and return the native answers", async () => {
	const { pilo, calls } = fakeNative();
	const client = new NshPiloClient(pilo);
	const model = { provider: "relay", id: "m1" };

	expect(await client.loadNextPromptSettings("local")).toEqual({
		connectionId: "local",
		enabled: false,
		model: null,
		updatedAtMs: 0,
	});
	expect(await client.saveNextPromptSettings("local", true, model)).toEqual({
		connectionId: "local",
		enabled: true,
		updatedAtMs: 9,
	});
	await client.saveNextPromptSettings("local", false, null);
	expect(calls).toEqual([
		["loadNextPromptSettings", "local"],
		["saveNextPromptSettings", "local", true, model],
		["saveNextPromptSettings", "local", false, null],
	]);
});

test("next-prompt settings the native module refuses reject with its error", async () => {
	const failure = new Error("Connection 'gone' was not found");
	const { pilo } = fakeNative({
		loadNextPromptSettings: () => Promise.reject(failure),
		saveNextPromptSettings: () => Promise.reject(failure),
	});
	const client = new NshPiloClient(pilo);
	for (const call of [
		client.loadNextPromptSettings("gone"),
		client.saveNextPromptSettings("gone", false, null),
	]) {
		let caught: unknown;
		await call.catch((error: unknown) => {
			caught = error;
		});
		expect(caught).toBe(failure);
	}
});

test("a next-prompt request and its cancellation pass through to the native module", async () => {
	const { pilo, calls } = fakeNative();
	const client = new NshPiloClient(pilo);
	const request = {
		sessionKey: "k1",
		sessionId: "s1",
		requestId: "r1",
		generation: 2,
		revision: 7,
	};

	expect(await client.requestNextPrompt(request)).toBe(undefined);
	await client.requestNextPrompt({ ...request, cancel: true });
	expect(calls).toEqual([
		["requestNextPrompt", request],
		["requestNextPrompt", { ...request, cancel: true }],
	]);
});

test("a next-prompt request the native module refuses rejects with its error", async () => {
	const failure = new Error("prediction session is not running");
	const { pilo } = fakeNative({
		requestNextPrompt: () => Promise.reject(failure),
	});
	let caught: unknown;
	await new NshPiloClient(pilo)
		.requestNextPrompt({
			sessionKey: "k1",
			sessionId: "s1",
			requestId: "r1",
			generation: 2,
			revision: 7,
		})
		.catch((error: unknown) => {
			caught = error;
		});
	expect(caught).toBe(failure);
});

test("a transcript snapshot passes its session key and window and returns the native answer", async () => {
	const { pilo, calls } = fakeNative();
	const client = new NshPiloClient(pilo);
	const window = { messageLimit: 40, includeMessageIndex: true };

	expect(await client.chatTranscriptSnapshot("k1", window)).toEqual({
		eventSequence: 12,
		sessionKey: "k1",
		generation: 1,
		live: { type: "idle" },
	});
	await client.chatTranscriptSnapshot("k1");
	expect(calls).toEqual([
		["chatTranscriptSnapshot", "k1", window],
		["chatTranscriptSnapshot", "k1", undefined],
	]);
});

test("a transcript snapshot the native module refuses rejects with its error", async () => {
	const failure = new Error("chat session is not running");
	const { pilo } = fakeNative({
		chatTranscriptSnapshot: () => Promise.reject(failure),
	});
	let caught: unknown;
	await new NshPiloClient(pilo)
		.chatTranscriptSnapshot("gone")
		.catch((error: unknown) => {
			caught = error;
		});
	expect(caught).toBe(failure);
});

test("a history read passes its session and window and returns the native answer", async () => {
	const { pilo, calls } = fakeNative();
	const client = new NshPiloClient(pilo);
	const options = {
		startMessage: 4,
		messageLimit: 40,
		includeMessageIndex: false,
		fingerprint: { fileSize: 9, fileMtimeNs: "7" },
	};

	expect(await client.loadHistory("p1", "/s.jsonl", options)).toEqual({
		history: { totalMessages: 2 },
		fingerprint: { fileSize: 9, fileMtimeNs: "7" },
	});
	await client.loadHistory("p1", "/s.jsonl");
	expect(calls).toEqual([
		["loadHistory", "p1", "/s.jsonl", options],
		["loadHistory", "p1", "/s.jsonl", undefined],
	]);
});

test("a history read the native module refuses rejects with its error", async () => {
	const failure = new Error("No such file or directory");
	const { pilo } = fakeNative({ loadHistory: () => Promise.reject(failure) });
	let caught: unknown;
	await new NshPiloClient(pilo)
		.loadHistory("p1", "/gone.jsonl")
		.catch((error: unknown) => {
			caught = error;
		});
	expect(caught).toBe(failure);
});

test("prompt enhancement settings calls pass their arguments and return the native answers", async () => {
	const { pilo, calls } = fakeNative();
	const client = new NshPiloClient(pilo);
	const model = { provider: "relay", id: "m1" };

	expect(await client.loadPromptEnhancementSettings("local")).toEqual({
		connectionId: "local",
		enabled: false,
		model: null,
		updatedAtMs: 0,
	});
	expect(
		await client.savePromptEnhancementSettings("local", true, model),
	).toEqual({ connectionId: "local", enabled: true, updatedAtMs: 9 });
	await client.savePromptEnhancementSettings("local", false, null);
	expect(calls).toEqual([
		["loadPromptEnhancementSettings", "local"],
		["savePromptEnhancementSettings", "local", true, model],
		["savePromptEnhancementSettings", "local", false, null],
	]);
});

test("prompt enhancement settings the native module refuses reject with its error", async () => {
	const failure = new Error("Connection 'gone' was not found");
	const { pilo } = fakeNative({
		loadPromptEnhancementSettings: () => Promise.reject(failure),
		savePromptEnhancementSettings: () => Promise.reject(failure),
	});
	const client = new NshPiloClient(pilo);
	for (const call of [
		client.loadPromptEnhancementSettings("gone"),
		client.savePromptEnhancementSettings("gone", false, null),
	]) {
		let caught: unknown;
		await call.catch((error: unknown) => {
			caught = error;
		});
		expect(caught).toBe(failure);
	}
});

test("a prompt enhancement passes its project, draft and model and returns the rewrite", async () => {
	const { pilo, calls } = fakeNative();
	const client = new NshPiloClient(pilo);
	const model = { provider: "relay", id: "m1" };

	expect(await client.enhancePrompt("p1", "parser test pls", model)).toBe(
		"Fix the parser's unit test.",
	);
	await client.enhancePrompt("p1", "parser test pls", null);
	expect(calls).toEqual([
		["enhancePrompt", "p1", "parser test pls", model],
		["enhancePrompt", "p1", "parser test pls", null],
	]);
});

test("a prompt enhancement the native module refuses rejects with its error", async () => {
	const failure = new Error("Prompt enhancement is disabled");
	const { pilo } = fakeNative({
		enhancePrompt: () => Promise.reject(failure),
	});
	let caught: unknown;
	await new NshPiloClient(pilo)
		.enhancePrompt("p1", "parser test pls", null)
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
		{ timeout: 30_000 },
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

test("the client loads and saves cache keep-alive policies through the native module", async () => {
	const app = await open("./pilo-client-keep-alive-fixture.tsx");
	await app.waitFor("text:client cache keep-alive policies verified", {
		timeout: 30_000,
	});
});

test("the client loads and saves next-prompt settings through the native module", async () => {
	const app = await open("./pilo-client-next-prompt-fixture.tsx");
	await app.waitFor("text:client next-prompt settings verified", {
		timeout: 30_000,
	});
});

test("the client requests and cancels a next-prompt suggestion through the native module", async () => {
	const app = await open("./pilo-client-next-prompt-request-fixture.tsx");
	await app.waitFor("text:client next-prompt suggestion and cancel verified", {
		timeout: 30_000,
	});
});

test("the client takes idle, active and truncated transcript snapshots through the native module", async () => {
	const app = await open("./pilo-client-transcript-fixture.tsx");
	await app.waitFor("text:client transcript snapshots verified", {
		timeout: 30_000,
	});
});

test("the client reads settled session history through the native module", async () => {
	const app = await open("./pilo-client-history-fixture.tsx");
	await app.waitFor("text:client settled history verified", {
		timeout: 30_000,
	});
});

test("the client loads and saves prompt enhancement settings through the native module", async () => {
	const app = await open("./pilo-client-prompt-enhancement-fixture.tsx");
	await app.waitFor("text:client prompt enhancement settings verified", {
		timeout: 30_000,
	});
});

test("the client rewrites a draft through the native module", async () => {
	const app = await open("./pilo-client-enhance-prompt-fixture.tsx");
	await app.waitFor("text:client prompt enhancement verified", {
		timeout: 30_000,
	});
});
