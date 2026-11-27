import { expect, open, test } from "nsh/test";
import process from "process";

import type {
	PiloClientEventMessage,
	PiloClientEventOptions,
} from "@shared/api/pilo-client";
import {
	createNativeHostClient,
	type NativeHostBackend,
} from "../client/native-transport";
import { createNativeDesktopShell } from "../shell/native-desktop-shell";

type Call = [method: string, ...args: unknown[]];

function fakeNative(
	overrides: Partial<
		NativeHostBackend & Parameters<typeof createNativeDesktopShell>[0]
	> = {},
) {
	const calls: Call[] = [];
	const preferences = { revision: 3, values: { locale: "zh-CN" } };
	const readState = {
		projectId: "p1",
		sessionPath: "/s.jsonl",
		completedRevision: 2,
		readRevision: 1,
	};
	const call = (method: string, params: unknown) => {
		calls.push([method, params]);
		switch (method) {
			case "host.bootstrap":
				return Promise.resolve({
					eventSequence: 41,
					projects: [{ id: "p1" }],
					chatSessions: [{ sessionKey: "k1" }],
					preferences,
				});
			case "project.file.preview": {
				const url = (params as { url?: string }).url ?? "";
				if (url.endsWith("missing.md")) {
					return Promise.reject(new Error("file not found"));
				}
				return Promise.resolve({ path: "/code/empty.md", content: "" });
			}
			case "session.markRead":
				return Promise.resolve(readState);
			default:
				return Promise.resolve({});
		}
	};
	const upload = (method: string, params: unknown, data: Uint8Array) => {
		calls.push([method, params, data]);
		if (method === "chat.files.upload") {
			return Promise.resolve(".pilo/uploads/a.txt");
		}
		return Promise.resolve(undefined);
	};
	const download = (method: string, params: unknown) => {
		calls.push([method, params]);
		return Promise.resolve(new Uint8Array([1, 2, 3]));
	};
	const answer =
		<T>(method: string, value: T) =>
		(...args: unknown[]) => {
			calls.push([method, ...args]);
			return Promise.resolve(value);
		};
	const pilo: NativeHostBackend &
		Parameters<typeof createNativeDesktopShell>[0] = {
		call: call as NativeHostBackend["call"],
		upload: upload as NativeHostBackend["upload"],
		download: download as NativeHostBackend["download"],
		nextEvents: answer("nextEvents", {
			type: "closed",
		}) as NativeHostBackend["nextEvents"],
		nextTerminalEvents: answer(
			"nextTerminalEvents",
			[],
		) as NativeHostBackend["nextTerminalEvents"],
		shutdown: answer("shutdown", undefined),
		pickLocalProjectDirectory: answer(
			"pickLocalProjectDirectory",
			"/code/picked",
		),
		openFileLink: answer("openFileLink", undefined),
		openLogDirectory: answer("openLogDirectory", undefined),
		...overrides,
	};
	return { pilo, calls, preferences, readState };
}

test("HostClient forwards pairing and device permissions via NativeTransport.call", async () => {
	const { pilo, calls } = fakeNative();
	const client = createNativeHostClient(pilo);
	await client.remotePairingRegenerate("chat,workspace");
	await client.remoteDeviceSetScopes("device-1", "chat");
	await client.remoteDevicesRevokeAll();
	expect(calls).toEqual([
		["remote.pairing.regenerate", { scopes: "chat,workspace" }],
		["remote.devices.setScopes", { deviceId: "device-1", scopes: "chat" }],
		["remote.devices.revokeAll", {}],
	]);
});

test("bootstrap carries the native event cut as latestSequence", async () => {
	const { pilo, preferences } = fakeNative();
	expect(await createNativeHostClient(pilo).bootstrap()).toEqual({
		projects: [{ id: "p1" }],
		chatSessions: [{ sessionKey: "k1" }],
		latestSequence: 41,
		preferences,
		localPiResources: undefined,
	});
});

test("upload and download normalize binary calls through NativeTransport", async () => {
	const { pilo, calls } = fakeNative();
	const client = createNativeHostClient(pilo);
	const payload = new Uint8Array([9, 8]);
	expect(await client.uploadChatFile("p1", "a.txt", payload)).toBe(
		".pilo/uploads/a.txt",
	);
	await client.writeTerminal("t1", payload);
	const bytes = await client.readHistoryImage("p1", "/s.jsonl", "img-1", {
		fileSize: 512,
		fileMtimeNs: "1234",
	});
	expect([...bytes]).toEqual([1, 2, 3]);
	expect(calls).toEqual([
		["chat.files.upload", { projectId: "p1", name: "a.txt" }, payload],
		["terminal.write", { terminalId: "t1" }, payload],
		[
			"session.historyImage",
			{
				projectId: "p1",
				sessionPath: "/s.jsonl",
				imageId: "img-1",
				expectedFileSize: 512,
				expectedFileMtimeNs: "1234",
			},
		],
	]);
});

test("the desktop shell picks directories and passes the process log file to the native module", async () => {
	const { pilo, calls } = fakeNative();
	const shell = createNativeDesktopShell(pilo);
	expect(await shell.pickLocalProjectDirectory()).toBe("/code/picked");
	await shell.openLogDirectory();
	expect(calls).toEqual([
		["pickLocalProjectDirectory"],
		["openLogDirectory", process.logFile],
	]);
});

test("the desktop shell preserves picker cancellation and missing native capability behavior", async () => {
	const { pilo } = fakeNative();
	const shell = createNativeDesktopShell({
		...pilo,
		pickLocalProjectDirectory: async () => null,
	});
	expect(await shell.pickLocalProjectDirectory()).toBe(null);
	expect(await shell.systemFontFamilies()).toEqual([]);
	let caught: unknown;
	try {
		await shell.readLocalFile("file:///image.png");
	} catch (error) {
		caught = error;
	}
	expect((caught as Error).message).toBe(
		"The native call readLocalFile is unavailable",
	);
});

test("the Host previews file links while the desktop shell only opens them", async () => {
	const { pilo, calls } = fakeNative();
	const host = createNativeHostClient(pilo);
	const shell = createNativeDesktopShell(pilo);
	expect(await host.previewFileLink("p1", "file:///code/empty.md")).toEqual({
		path: "/code/empty.md",
		content: "",
	});
	expect(await shell.openFileLink("p1", "file:///code/report.html")).toBe(
		undefined,
	);
	let caught: unknown;
	try {
		await host.previewFileLink("p1", "file:///code/missing.md");
	} catch (error) {
		caught = error;
	}
	expect((caught as Error).message).toBe("file not found");
	expect(calls).toEqual([
		["project.file.preview", { projectId: "p1", url: "file:///code/empty.md" }],
		["openFileLink", "p1", "file:///code/report.html"],
		[
			"project.file.preview",
			{ projectId: "p1", url: "file:///code/missing.md" },
		],
	]);
});

test("temporary_chat_left waits for an in-flight noSession start before calling chat.stop", async () => {
	const order: string[] = [];
	let releaseStart!: () => void;
	const startReady = new Promise<void>((resolve) => {
		releaseStart = resolve;
	});
	const { pilo } = fakeNative({
		call: (async (method: string, params: unknown) => {
			order.push(`start:${method}`);
			if (method === "chat.start") {
				await startReady;
				order.push(`done:${method}`);
				return {
					sessionKey: (params as { sessionKey: string }).sessionKey,
					projectId: "p1",
					status: "idle",
				};
			}
			order.push(`done:${method}`);
			return undefined;
		}) as NativeHostBackend["call"],
	});
	const client = createNativeHostClient(pilo);

	const starting = client.startChat({
		projectId: "p1",
		sessionKey: "temp-1",
		noSession: true,
	});
	const stopping = client.stopChat("temp-1", "temporary_chat_left");
	await settle();
	expect(order).toEqual(["start:chat.start"]);

	releaseStart();
	await Promise.all([starting, stopping]);
	expect(order).toEqual([
		"start:chat.start",
		"done:chat.start",
		"start:chat.stop",
		"done:chat.stop",
	]);
});

test("searchSessions defaults limit to 24 and forwards explicit limits", async () => {
	const { pilo, calls } = fakeNative();
	const client = createNativeHostClient(pilo);
	await client.searchSessions("p1", "hello");
	await client.searchSessions("p1", "hello", 50);
	expect(calls).toEqual([
		["session.search", { projectId: "p1", query: "hello", limit: 24 }],
		["session.search", { projectId: "p1", query: "hello", limit: 50 }],
	]);
});

test("archive, unarchive, markSessionRead validation, and error propagation behave consistently", async () => {
	const { pilo, calls } = fakeNative({
		call: (async (method: string, params: unknown) => {
			calls.push([method, params]);
			if (method === "session.delete") {
				throw new Error("cannot delete active session");
			}
			return {};
		}) as NativeHostBackend["call"],
	});
	const client = createNativeHostClient(pilo);
	await client.archiveSession("p1", "/s.jsonl");
	await client.unarchiveSession("p1", "/s.jsonl");
	await client.saveModelScope("p1", []);
	await client.saveModelScope("p1", null);
	await client.chatTranscriptSnapshot("k1", {
		startMessage: 10,
		messageLimit: 25,
	});
	await client.loadHistory("p1", "/s.jsonl", {
		fingerprint: { fileSize: 128, fileMtimeNs: "999" },
		startMessage: 5,
		messageLimit: 20,
	});

	let readErr: unknown;
	try {
		await client.markSessionRead("p1", "/s.jsonl", 0);
	} catch (error) {
		readErr = error;
	}
	expect((readErr as Error).message).toBe(
		"session read revision must be a positive safe integer",
	);

	let delErr: unknown;
	try {
		await client.deleteSession("p1", "/s.jsonl");
	} catch (error) {
		delErr = error;
	}
	expect((delErr as Error).message).toBe("cannot delete active session");

	expect(calls).toEqual([
		[
			"session.uiState.set",
			{ projectId: "p1", sessionPath: "/s.jsonl", update: { archived: true } },
		],
		[
			"session.uiState.set",
			{ projectId: "p1", sessionPath: "/s.jsonl", update: { archived: false } },
		],
		["models.scope.set", { projectId: "p1", models: [] }],
		["models.scope.set", { projectId: "p1", models: null }],
		[
			"chat.transcript",
			{ sessionKey: "k1", window: { startMessage: 10, messageLimit: 25 } },
		],
		[
			"session.history",
			{
				projectId: "p1",
				sessionPath: "/s.jsonl",
				expectedFileSize: 128,
				expectedFileMtimeNs: "999",
				startMessage: 5,
				messageLimit: 20,
				includeMessageIndex: undefined,
			},
		],
		["session.delete", { projectId: "p1", sessionPath: "/s.jsonl" }],
	]);
});

function fakeEventStream() {
	const polls: {
		max: number;
		resolve: (batch: unknown) => void;
		reject: (error: Error) => void;
	}[] = [];
	const { pilo } = fakeNative({
		nextEvents: (max) =>
			new Promise((resolve, reject) =>
				polls.push({ max, resolve, reject }),
			) as ReturnType<NativeHostBackend["nextEvents"]>,
	});
	return { client: createNativeHostClient(pilo), polls };
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
});

test("a queue overflow gap becomes resyncRequired with lastMissed", async () => {
	const { client, polls } = fakeEventStream();
	const target = listener();
	await client.connectEvents(target.options);
	await settle();

	polls[0]?.resolve({ type: "gap", firstMissed: 4, lastMissed: 11 });
	await settle();
	polls[1]?.resolve(events(12));
	await settle();

	expect(target.messages).toEqual([
		{ type: "resyncRequired", latestSequence: 11 },
		events(12),
	]);
});

test("disconnecting while a poll is in flight holds its batch for the next listener", async () => {
	const { client, polls } = fakeEventStream();
	const first = listener();
	const disconnect = await client.connectEvents(first.options);
	await settle();
	disconnect();
	expect(first.statuses).toEqual([true, false]);

	polls[0]?.resolve(events(5));
	await settle();
	expect(first.messages).toEqual([]);
	expect(polls.length).toBe(1);

	const second = listener();
	await client.connectEvents(second.options);
	await settle();
	expect(second.messages).toEqual([events(5)]);
	expect(polls.length).toBe(2);
});

test("a closed event stream disconnects listeners and marks the client closed", async () => {
	const { client, polls } = fakeEventStream();
	const target = listener();
	await client.connectEvents(target.options);
	await settle();
	expect(client.closed).toBe(false);

	polls[0]?.resolve({ type: "closed" });
	await settle();
	expect(client.closed).toBe(true);
	expect(target.statuses).toEqual([true, false]);

	const late = listener();
	await client.connectEvents(late.options);
	expect(late.statuses).toEqual([false]);
	expect(polls.length).toBe(1);
});

test("a failed poll disconnects listeners and reconnecting resumes polling", async () => {
	const { client, polls } = fakeEventStream();
	const first = listener();
	await client.connectEvents(first.options);
	await settle();

	polls[0]?.reject(new Error("native poll failed"));
	await settle();
	expect(first.statuses).toEqual([true, false]);
	expect(client.closed).toBe(false);

	const second = listener();
	await client.connectEvents(second.options);
	await settle();
	expect(polls.length).toBe(2);
	polls[1]?.resolve(events(9));
	await settle();
	expect(second.messages).toEqual([events(9)]);
});

test("a listener that throws does not stop delivery to the others", async () => {
	const { client, polls } = fakeEventStream();
	const healthy = listener();
	await client.connectEvents({
		onMessage: () => {
			throw new Error("boom");
		},
		onStatus: () => undefined,
	});
	await client.connectEvents(healthy.options);
	await settle();

	polls[0]?.resolve(events(7));
	await settle();
	expect(healthy.messages).toEqual([events(7)]);
});

test("the client reads and updates Host data through the native module", async () => {
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
