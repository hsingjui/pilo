import assert from "node:assert/strict";
import test from "node:test";

import {
	getNextPiQuickCycleModel,
	getPiModelThinkingLevels,
	getPiQuickCycleModels,
	getPiQuickCycleThinkingLevel,
	getProjectScopeDefaultModel,
} from "../../src/lib/pi-model-selection.ts";
import type { PiModel } from "../../src/lib/api/pi-runtime.ts";
import type { ProjectModelScope } from "../../src/lib/project-model-scope.ts";

function model(id: string, overrides: Partial<PiModel> = {}): PiModel {
	return {
		id,
		name: id,
		provider: "test",
		reasoning: true,
		...overrides,
	};
}

test("Pi quick cycle prefers scoped models in scope order", () => {
	const models = [
		model("outside", { scopeOrder: null }),
		model("second", { scopeOrder: 1 }),
		model("first", { scopeOrder: 0 }),
	];

	assert.deepEqual(
		getPiQuickCycleModels(models).map((item) => item.id),
		["first", "second"],
	);
	assert.equal(getNextPiQuickCycleModel(models, models[2])?.id, "second");
	assert.equal(getNextPiQuickCycleModel(models, models[1])?.id, "first");
});

test("Pi quick cycle falls back to all models when no scope is configured", () => {
	const models = [
		model("one", { scopeOrder: null }),
		model("two", { scopeOrder: null }),
	];

	assert.deepEqual(
		getPiQuickCycleModels(models).map((item) => item.id),
		["one", "two"],
	);
	assert.equal(getNextPiQuickCycleModel(models, models[0])?.id, "two");
});

test("Pi quick cycle uses the scoped thinking level when available", () => {
	const scoped = model("scoped", {
		scopeOrder: 0,
		scopeThinkingLevel: "high",
		defaultThinkingLevel: "low",
	});
	const regular = model("regular", {
		scopeOrder: null,
		defaultThinkingLevel: "medium",
	});

	assert.equal(getPiQuickCycleThinkingLevel(scoped), "high");
	assert.equal(getPiQuickCycleThinkingLevel(regular), "medium");
});

test("a custom project's first Scope model supplies the new-chat default and thinking override", () => {
	const models = [
		model("pi-default", { scopeOrder: 0 }),
		model("first", { defaultThinkingLevel: "low" }),
		model("first", { provider: "other" }),
	];
	const scope: ProjectModelScope = {
		projectId: "project",
		models: [
			{ provider: "test", modelId: "first", thinkingLevel: "high" },
			{ provider: "test", modelId: "pi-default", thinkingLevel: "low" },
		],
		updatedAtMs: 1,
	};
	const selected = getProjectScopeDefaultModel(models, scope);
	assert.equal(selected?.provider, "test");
	assert.equal(selected?.id, "first");
	assert.equal(selected?.scopeOrder, 0);
	assert.ok(selected);
	assert.equal(getPiQuickCycleThinkingLevel(selected), "high");
	assert.equal(models[1].scopeThinkingLevel, undefined);
});

test("a Scope default without a thinking override uses the model profile", () => {
	const selected = getProjectScopeDefaultModel(
		[model("first", { defaultThinkingLevel: "medium" })],
		{
			projectId: "project",
			models: [{ provider: "test", modelId: "first", thinkingLevel: null }],
			updatedAtMs: 1,
		},
	);
	assert.ok(selected);
	assert.equal(getPiQuickCycleThinkingLevel(selected), "medium");
});

test("absent, inherited and empty project Scopes leave the default to Pi", () => {
	const models = [model("pi-default", { scopeOrder: 0 })];
	for (const scope of [
		null,
		{ projectId: "project", models: null, updatedAtMs: 1 },
		{ projectId: "project", models: [], updatedAtMs: 1 },
	]) {
		assert.equal(getProjectScopeDefaultModel(models, scope), null);
	}
});

test("an unavailable first Scope model does not silently select a later member", () => {
	assert.equal(
		getProjectScopeDefaultModel([model("available")], {
			projectId: "project",
			models: [
				{ provider: "other", modelId: "available", thinkingLevel: "high" },
				{ provider: "test", modelId: "available", thinkingLevel: "low" },
			],
			updatedAtMs: 1,
		}),
		null,
	);
});

test("thinking levels expose only the selected model profile", () => {
	const restricted = model("restricted", {
		thinkingLevels: ["off", "low", "high"],
	});

	assert.deepEqual(getPiModelThinkingLevels(restricted), [
		"off",
		"low",
		"high",
	]);
	assert.deepEqual(getPiModelThinkingLevels(model("unknown")), []);
});
