import assert from "node:assert/strict";
import test from "node:test";

import {
	buildConversationOutline,
	getOutlineIndexForVisibleRange,
	sampleOutlineEntries,
} from "../../src/lib/chat/conversation-outline.ts";

const msg = (
	id: string,
	role: "user" | "assistant" | "compaction",
	text = "x",
) => ({
	id,
	role,
	text,
});

const entries = buildConversationOutline([
	msg("u1", "user", "primera"),
	msg("a1", "assistant", "respuesta"),
	msg("u2", "user", "segunda"),
	msg("a2", "assistant", "respuesta"),
	msg("u3", "user", "tercera"),
]);

test("a round opens on each user message", () => {
	assert.deepEqual(
		entries.map((entry) => entry.messageIndex),
		[0, 2, 4],
	);
});

test("the active entry is the last round that started on or before the first visible message", () => {
	assert.equal(getOutlineIndexForVisibleRange(entries, 0, false), 0);
	assert.equal(getOutlineIndexForVisibleRange(entries, 2, false), 1);
	assert.equal(getOutlineIndexForVisibleRange(entries, 3, false), 1);
	assert.equal(getOutlineIndexForVisibleRange(entries, 4, false), 2);
});

test("at the end the last entry is active even when the top is inside an earlier round", () => {
	assert.equal(getOutlineIndexForVisibleRange(entries, 1, true), 2);
});

test("an empty outline has no active entry", () => {
	assert.equal(getOutlineIndexForVisibleRange([], 0, false), -1);
});

test("sampling keeps every entry when they fit", () => {
	assert.deepEqual(
		sampleOutlineEntries(entries, 3).map((tick) => tick.index),
		[0, 1, 2],
	);
});

test("sampling over a long outline is uniform and keeps the ends", () => {
	const many = buildConversationOutline(
		Array.from({ length: 100 }, (_, index) =>
			msg(`u${index}`, "user", `ronda ${index}`),
		),
	);
	const ticks = sampleOutlineEntries(many, 10);
	assert.equal(ticks.length, 10);
	assert.equal(ticks[0].index, 0);
	assert.equal(ticks.at(-1)?.index, 99);
	assert.deepEqual(
		ticks.map((tick) => tick.index),
		ticks.map((tick) => tick.index).toSorted((a, b) => a - b),
	);
});

test("sampling to one tick keeps the last entry", () => {
	assert.deepEqual(
		sampleOutlineEntries(entries, 1).map((tick) => tick.index),
		[2],
	);
	assert.deepEqual(sampleOutlineEntries(entries, 0), []);
});
