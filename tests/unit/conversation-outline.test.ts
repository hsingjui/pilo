import assert from "node:assert/strict";
import test from "node:test";

import {
	buildConversationOutline,
	getOutlineIndexForVisibleRange,
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
