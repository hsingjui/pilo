import assert from "node:assert/strict";
import test from "node:test";

import {
	getNextPiQuickCycleModel,
	getPiModelThinkingLevels,
	getPiQuickCycleModels,
	getPiQuickCycleThinkingLevel,
} from "../src/lib/pi-model-selection.ts";
import type { PiModel } from "../src/lib/pi-runtime.ts";

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
