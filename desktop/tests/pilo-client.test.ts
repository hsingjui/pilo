import { expect, open, test } from "nsh/test";

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

test("the client reads and writes Host data through the native module", async () => {
	const app = await open("./pilo-client-fixture.tsx");
	await app.waitFor(
		"text:client data calls verified against the native module",
	);
});
