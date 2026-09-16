import assert from "node:assert/strict";
import test from "node:test";

import { createChatConversationStore } from "../src/components/chat/chat-conversation-store.ts";
import { createConversationState } from "../src/lib/conversation-reducer.ts";

test("conversation store only notifies mounted subscribers", () => {
	const store = createChatConversationStore();
	const first = createConversationState([]);
	const second = { ...first, pendingUsers: [] };
	let notifications = 0;

	store.setSnapshot(first);
	assert.equal(notifications, 0);
	assert.equal(store.getSnapshot(), first);

	const unsubscribe = store.subscribe(() => {
		notifications += 1;
	});
	store.setSnapshot(second);
	assert.equal(notifications, 1);
	assert.equal(store.getSnapshot(), second);

	unsubscribe();
	store.setSnapshot(first);
	assert.equal(notifications, 1);
	assert.equal(store.getSnapshot(), first);
});
