import assert from "node:assert/strict";
import test from "node:test";

import { createChatHistoryWindowStore } from "../src/components/chat/chat-history-window-store.ts";
import type { ChatMessage } from "../src/lib/conversation-types.ts";
import type { SessionHistoryMessageIndexEntry } from "../src/lib/sessions.ts";

function descriptor(index: number): SessionHistoryMessageIndexEntry {
	return {
		id: `message-${index}`,
		role: index % 2 === 0 ? "user" : "assistant",
		preview: `preview ${index}`,
		estimatedChars: 100,
	};
}

function message(index: number): ChatMessage {
	return index % 2 === 0
		? {
				id: `message-${index}`,
				role: "user",
				text: `body ${index}`,
				time: "",
			}
		: {
				id: `message-${index}`,
				role: "assistant",
				text: `body ${index}`,
				time: "",
			};
}

test("history hydration keeps pinned bodies and evicts least recently used bodies", () => {
	const store = createChatHistoryWindowStore(2);
	store.initialize(
		Array.from({ length: 6 }, (_, index) => descriptor(index)),
		6,
	);
	store.hydrate(0, [message(0), message(1)]);
	store.setPinnedRange(1, 1);
	store.hydrate(2, [message(2)]);

	let snapshot = store.getSnapshot();
	assert.equal(snapshot.hydrated.has(0), false);
	assert.equal(snapshot.hydrated.has(1), true);
	assert.equal(snapshot.hydrated.has(2), true);

	store.setPinnedRange(3, 3);
	store.hydrate(3, [message(3)]);
	snapshot = store.getSnapshot();
	assert.equal(snapshot.hydrated.size, 2);
	assert.equal(snapshot.hydrated.has(1), false);
	assert.equal(snapshot.hydrated.has(2), true);
	assert.equal(snapshot.hydrated.has(3), true);
});

test("history hydration never stores bodies owned by the runtime tail", () => {
	const store = createChatHistoryWindowStore();
	store.initialize(
		Array.from({ length: 10 }, (_, index) => descriptor(index)),
		6,
	);
	store.hydrate(5, [message(5), message(6), message(7)]);

	const snapshot = store.getSnapshot();
	assert.equal(snapshot.hydrated.has(5), true);
	assert.equal(snapshot.hydrated.has(6), false);
	assert.equal(snapshot.hydrated.has(7), false);
});
