import { expect, test } from "nsh/test";

import type { PiloClientEventOptions } from "@shared/api/pilo-client";
import type { SessionIndexEntry } from "@shared/api/sessions-types";
import { requestPiRpc } from "../client/chat-rpc";
import { scriptedClient } from "./scripted-app-client";

test("a scripted command reply resolves the rpc and is recorded", async () => {
	const { client, commands } = scriptedClient({
		onCommand: (sessionKey, command) =>
			command.type === "get_session_stats"
				? { data: { sessionKey, totalMessages: 3 } }
				: undefined,
	});
	const stats = await requestPiRpc<{ totalMessages: number }>(client, "k1", {
		type: "get_session_stats",
	});
	expect(stats).toEqual({ sessionKey: "k1", totalMessages: 3 });
	expect(commands).toEqual([
		["k1", { type: "get_session_stats", id: "nsh-rpc-1" }],
	]);
});

test("an unanswered command and a failed reply resolve like the real client", async () => {
	const { client } = scriptedClient({
		onCommand: (_sessionKey, command) =>
			command.type === "fork"
				? { success: false, error: "no entry" }
				: undefined,
	});
	const missing = await requestPiRpc(client, "k1", { type: "get_state" }, 20);
	expect(missing).toBeNull();
	await expect(
		requestPiRpc(client, "k1", { type: "fork" }, 20),
	).rejects.toThrow("no entry");
});

test("chat lifecycle, model cache, scope and ui-state calls round-trip", async () => {
	const { client, commands } = scriptedClient({
		models: { p2: { projectId: "p2" } as never },
	});
	const snapshot = await client.startChat({
		projectId: "p1",
		sessionKey: "k1",
		noSession: true,
	});
	expect(snapshot.state).toBe("running");
	await client.stopChat("k1");

	const saved = {
		projectId: "p1",
		models: [],
		commands: null,
		defaultModel: null,
		defaultThinkingLevel: null,
		refreshedAtMs: 9,
	};
	expect(await client.saveModels(saved)).toEqual(saved);
	expect(await client.loadModels("p1")).toEqual(saved);
	expect(await client.loadModels("p2")).toEqual({ projectId: "p2" });
	expect(await client.loadModels("p3")).toBeNull();

	expect(await client.loadModelScope("p1")).toEqual({
		projectId: "p1",
		models: null,
		updatedAtMs: 0,
	});
	const scopeEvents: unknown[] = [];
	const disconnect = await client.connectEvents({
		onMessage: (message) => {
			if (message.type === "events") scopeEvents.push(...message.events);
		},
		onStatus: () => {},
	} as PiloClientEventOptions);
	const scope = await client.saveModelScope("p1", [
		{ provider: "openai", modelId: "gpt-5", thinkingLevel: "low" },
	]);
	expect(scope.models).toHaveLength(1);
	expect(await client.loadModelScope("p1")).toEqual(scope);
	expect(scopeEvents).toEqual([
		{ type: "project_model_scope_changed", scope, sequence: 1 },
	]);
	disconnect();

	const entry = await client.updateSessionUiState(
		"/s.jsonl",
		{ pinned: true, titleOverride: "Renamed" },
		"p1",
	);
	expect(entry).toEqual({
		sessionPath: "/s.jsonl",
		pinned: true,
		titleOverride: "Renamed",
	});
	// The scope save sends no chat command.
	expect(commands).toEqual([]);
});

test("scripted archive and restore update only the targeted project's index", async () => {
	const entry = (projectId: string) =>
		({
			projectId,
			sessionPath: "/s.jsonl",
			pinned: true,
			titleOverride: "Renamed",
		}) as SessionIndexEntry;
	const { client } = scriptedClient({
		sessions: async (projectId) =>
			projectId === "empty" ? [] : [entry(projectId)],
	});
	const events: unknown[] = [];
	const disconnect = await client.connectEvents({
		onMessage: (message) => {
			if (message.type === "events") events.push(...message.events);
		},
		onStatus: () => {},
	});
	const archived = await client.archiveSession("p1", "/s.jsonl");
	expect(typeof archived.archivedAt).toBe("number");
	expect(archived.pinned).toBe(false);
	expect(archived.titleOverride).toBe("Renamed");
	expect(await client.listSessions("p2")).toEqual([entry("p2")]);

	const restored = await client.unarchiveSession("p1", "/s.jsonl");
	expect(restored.archivedAt).toBeNull();
	expect(restored.pinned).toBe(false);
	expect(await client.listSessions("p1")).toEqual([restored]);
	await expect(client.archiveSession("empty", "/s.jsonl")).rejects.toThrow(
		"not indexed",
	);
	expect(events).toEqual([
		{ type: "sessions_indexed", projectId: "p1", sequence: 1 },
		{ type: "sessions_indexed", projectId: "p1", sequence: 2 },
	]);
	disconnect();
});
