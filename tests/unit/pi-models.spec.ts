import assert from "node:assert/strict";
import test from "node:test";

import {
	probeProjectPiModels,
	type PiModelProbeClient,
} from "../../shared/api/pi-models-probe.ts";
import type { ProjectPiModels } from "../../shared/api/pi-models-types.ts";
import type { PiCommand, PiModel } from "../../shared/api/pi-runtime-types.ts";
import { isPiScopeCatalogResolved } from "../../shared/pi-model-selection.ts";

const model: PiModel = {
	id: "test-model",
	name: "Test model",
	provider: "test",
	reasoning: false,
	defaultThinkingLevel: "off",
	thinkingLevels: ["off"],
	scopeOrder: null,
	scopeThinkingLevel: null,
};

function command(
	name: string,
	source: PiCommand["source"] = "extension",
): PiCommand {
	return {
		name,
		source,
		sourceInfo: {
			path: "/project/.pi/extension.ts",
			source: "local",
			scope: "project",
			origin: "top-level",
		},
	};
}

function catalog(projectId = "catalog-test"): ProjectPiModels {
	return {
		projectId,
		models: [model],
		commands: [],
		defaultModel: model,
		defaultThinkingLevel: "off",
		refreshedAtMs: 0,
	};
}

function probe(commands: PiCommand[]): PiModelProbeClient {
	return {
		prepare: async () => ({
			generation: 1,
			state: "running",
			connection: null,
			projectId: null,
		}),
		dispose: async () => {},
		listen: async () => () => {},
		getPiCommands: async () => ({ commands }),
		getAvailablePiModels: async () => ({ models: [model] }),
		getPiAgentState: async () => ({
			model,
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			messageCount: 0,
			pendingMessageCount: 0,
		}),
		getAvailablePiThinkingLevels: async () => ({ levels: ["off"] }),
		cyclePiModel: async () => null,
		setPiModel: async () => model,
		setPiThinkingLevel: async () => {},
		executePiCommand: async () => {
			throw new Error("catalog extension unavailable");
		},
		respondToExtensionUi: async () => {},
	};
}

test("scope resolution detects models missing scope metadata", () => {
	assert.equal(isPiScopeCatalogResolved(catalog().models), true);
	assert.equal(
		isPiScopeCatalogResolved([{ ...model, scopeOrder: undefined }]),
		false,
	);
});

test("probe loads models and commands, filters its internal command and cleans up", async (t) => {
	t.mock.method(console, "warn", () => {});
	const client = probe([
		command("example"),
		command("skill:example", "skill"),
		command("pilo_model_catalog"),
	]);
	const createClient = t.mock.fn(() => client);
	const dispose = t.mock.method(client, "dispose");
	const readCommands = t.mock.method(client, "getPiCommands");
	const persist = t.mock.fn(async (snapshot: ProjectPiModels) => ({
		...snapshot,
		refreshedAtMs: 42,
	}));
	const result = await probeProjectPiModels(
		"shared-probe",
		{ cached: null, createClient, persist },
		{ onTrace: () => {} },
	);
	assert.equal(createClient.mock.callCount(), 1);
	assert.equal(readCommands.mock.callCount(), 1);
	assert.equal(dispose.mock.callCount(), 1);
	assert.equal(persist.mock.callCount(), 1);
	assert.deepEqual(
		result.commands?.map((entry) => entry.name),
		["example", "skill:example"],
	);
	assert.equal(result.models[0]?.id, model.id);
	assert.equal(result.refreshedAtMs, 42);
});

test("command lookup failure preserves cached commands without failing model discovery", async (t) => {
	t.mock.method(console, "warn", () => {});
	const cached = { ...catalog("failed-commands"), commands: [command("keep")] };
	const client = probe([]);
	t.mock.method(client, "getPiCommands", async () => {
		throw new Error("command lookup failed");
	});
	const result = await probeProjectPiModels(
		cached.projectId,
		{
			cached,
			createClient: () => client,
			persist: async (snapshot) => snapshot,
		},
		{ onTrace: () => {} },
	);
	assert.deepEqual(result.commands, cached.commands);
	assert.equal(result.models[0]?.id, model.id);
});

test("failed discovery disposes the probe and allows another request", async (t) => {
	t.mock.method(console, "warn", () => {});
	const client = probe([]);
	const dispose = t.mock.method(client, "dispose");
	t.mock.method(client, "getAvailablePiModels", async () => {
		throw new Error("model lookup failed");
	});
	await assert.rejects(
		probeProjectPiModels(
			"failed-probe",
			{
				cached: null,
				createClient: () => client,
				persist: async (snapshot) => snapshot,
			},
			{ onTrace: () => {} },
		),
		/model lookup failed/,
	);
	assert.equal(dispose.mock.callCount(), 1);
	const result = await probeProjectPiModels(
		"failed-probe",
		{
			cached: null,
			createClient: () => probe([]),
			persist: async (snapshot) => snapshot,
		},
		{ onTrace: () => {} },
	);
	assert.deepEqual(result.commands, []);
	assert.equal(isPiScopeCatalogResolved(result.models), true);
});
