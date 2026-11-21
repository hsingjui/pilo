import { expect, test } from "nsh/test";

import type { ProjectPiModels } from "@shared/api/pi-models-types";
import type { PiAgentState, PiModel } from "@shared/api/pi-runtime-types";
import type { ProjectModelScope } from "@shared/project-model-scope";
import { ModelCatalogStore } from "../state/model-catalog";
import { scriptedClient } from "./scripted-app-client";

const gpt5: PiModel = {
	id: "gpt-5",
	name: "GPT-5",
	provider: "openai",
	reasoning: true,
};
const sonnet: PiModel = {
	id: "sonnet-4.5",
	name: "Sonnet 4.5",
	provider: "anthropic",
	reasoning: true,
};

const catalog = (models: PiModel[]): ProjectPiModels => ({
	projectId: "p1",
	models,
	commands: [{ name: "help" } as never],
	defaultModel: gpt5,
	defaultThinkingLevel: "high",
	refreshedAtMs: 1,
});

const scopedModels = () => [
	{ ...gpt5, scopeOrder: 0, scopeThinkingLevel: "high" as const },
	{ ...sonnet, scopeOrder: 1, scopeThinkingLevel: null },
];

test("open reads the persisted catalog and scope and exposes scope state", async () => {
	const scope: ProjectModelScope = {
		projectId: "p1",
		models: [
			{
				provider: "openai",
				modelId: "gpt-5",
				thinkingLevel: "high",
				isDefault: true,
			},
		],
		updatedAtMs: 2,
	};
	const { client } = scriptedClient({
		models: { p1: catalog(scopedModels()) },
		modelScopes: { p1: scope },
	});
	const store = new ModelCatalogStore(client);

	await store.open("p1");
	const state = store.state()!;
	expect(state.loaded).toBe(true);
	expect(state.catalog?.projectId).toBe("p1");
	expect(state.scope).toEqual(scope);
	expect(store.models).toHaveLength(2);
	expect(store.scopeModels).toHaveLength(1);
	expect(store.scopeDefaultModel?.id).toBe("gpt-5");
	expect(store.scopeResolved).toBe(true);
	expect(store.commands).toEqual([{ name: "help" }]);

	store.close();
	expect(store.state()).toBeNull();
});

test("a scope save updates the store and its event is applied", async () => {
	const { client, emit } = scriptedClient({
		models: { p1: catalog(scopedModels()) },
	});
	const store = new ModelCatalogStore(client);
	await store.open("p1");
	expect(store.scopeModels).toHaveLength(2); // inherits the Pi scope

	await store.saveScope([
		{ provider: "anthropic", modelId: "sonnet-4.5", thinkingLevel: null },
	]);
	const state = store.state()!;
	expect(state.savingScope).toBe(false);
	expect(state.scope?.models).toHaveLength(1);
	expect(store.scopeModels.map((model) => model.id)).toEqual(["sonnet-4.5"]);

	emit({
		type: "project_model_scope_changed",
		scope: { projectId: "p1", models: null, updatedAtMs: 3 },
	});
	emit({
		type: "project_model_scope_changed",
		scope: { projectId: "other", models: [], updatedAtMs: 4 },
	});
	expect(store.state()!.scope?.models).toBeNull();
});

test("refresh probes through the catalog extension and persists", async () => {
	const payload = {
		models: [
			{
				...gpt5,
				defaultThinkingLevel: "high",
				thinkingLevels: ["low", "high"],
				scopeOrder: 0,
				scopeThinkingLevel: "high",
			},
		],
		baselineModel: gpt5,
		baselineThinkingLevel: "high",
	};
	const { client, emit } = scriptedClient({
		onCommand: (sessionKey, command) => {
			if (command.type === "get_commands") return { data: { commands: [] } };
			if (command.type === "prompt") {
				queueMicrotask(() =>
					emit({
						type: "extension_ui_request",
						sessionKey,
						id: "req-1",
						title: "pilo-model-catalog:v1",
						message: JSON.stringify(payload),
					}),
				);
				return undefined;
			}
			return { data: {} };
		},
	});
	const store = new ModelCatalogStore(client);
	await store.open("p1");
	expect(store.state()!.catalog).toBeNull();

	await store.refresh();
	const state = store.state()!;
	expect(state.refreshing).toBe(false);
	expect(state.error).toBeNull();
	expect(state.catalog?.models[0]?.id).toBe("gpt-5");
	expect(state.catalog?.defaultThinkingLevel).toBe("high");
	// The probe's snapshot is persisted through saveModels.
	expect(await client.loadModels("p1")).toEqual(state.catalog);
});

test("refresh falls back to the RPC chain without the extension", async () => {
	const agentState: PiAgentState = {
		model: gpt5,
		thinkingLevel: "high",
		isStreaming: false,
		isCompacting: false,
		messageCount: 0,
		pendingMessageCount: 0,
	};
	const { client } = scriptedClient({
		onCommand: (_sessionKey, command) => {
			switch (command.type) {
				case "get_commands":
					return { data: { commands: [] } };
				case "get_available_models":
					return { data: { models: [gpt5] } };
				case "get_state":
					return { data: agentState };
				case "cycle_model":
					return { data: null };
				case "set_model":
					return { data: gpt5 };
				case "set_thinking_level":
					return { data: null };
				case "get_available_thinking_levels":
					return { data: { levels: ["low", "high"] } };
			}
			return undefined;
		},
	});
	const store = new ModelCatalogStore(client);
	await store.open("p1");

	await store.refresh(50);
	const state = store.state()!;
	expect(state.refreshing).toBe(false);
	expect(state.error).toBeNull();
	const model = state.catalog?.models[0];
	expect(model?.id).toBe("gpt-5");
	expect(model?.defaultThinkingLevel).toBe("high");
	expect(model?.thinkingLevels).toEqual(["low", "high"]);
	expect(state.catalog?.defaultModel?.id).toBe("gpt-5");
});

test("a failing refresh keeps the catalog and reports its error", async () => {
	const { client } = scriptedClient({
		models: { p1: catalog(scopedModels()) },
		onStartChat: () => Promise.reject(new Error("no Pi binary")),
	});
	const store = new ModelCatalogStore(client);
	await store.open("p1");

	await store.refresh();
	const state = store.state()!;
	expect(state.refreshing).toBe(false);
	expect(state.error).toBe("no Pi binary");
	expect(state.catalog?.models).toHaveLength(2);
});
