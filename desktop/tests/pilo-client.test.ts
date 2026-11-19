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
		listProjects: answer("listProjects", [{ id: "p1" }]),
		listSessions: answer("listSessions", [{ piSessionId: "s1" }]),
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
