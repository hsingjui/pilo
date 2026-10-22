import assert from "node:assert/strict";
import test from "node:test";

import { historyContextPercent } from "../../src/components/chat/chat-session-config-model.ts";

test("history context percent needs both halves of the ratio", () => {
	assert.equal(historyContextPercent(25_000, 100_000), 25);
	assert.equal(historyContextPercent(0, 100_000), 0);
});

test("history context percent stays unknown without a usable window", () => {
	assert.equal(historyContextPercent(25_000, undefined), undefined);
	assert.equal(historyContextPercent(25_000, 0), undefined);
	assert.equal(historyContextPercent(null, 100_000), undefined);
	assert.equal(historyContextPercent(undefined, 100_000), undefined);
});

test("history context percent keeps a fractional share", () => {
	assert.equal(historyContextPercent(1, 3), (1 / 3) * 100);
});
