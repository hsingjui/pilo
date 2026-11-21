import assert from "node:assert/strict";
import test from "node:test";

import {
	PLAIN_SHORT_CHAT_HARD_MAX_MESSAGES,
	shouldInitializeShortChatPromoted,
	shouldRenderPlainShortChat,
} from "../../web/lib/chat/chat-virtualization.ts";

test("cold history skips the plain renderer before deferred promotion", () => {
	const promoted = shouldInitializeShortChatPromoted({
		enabled: true,
		messageCount: 0,
		streaming: false,
	});
	assert.equal(promoted, false);
	for (const messageCount of [200, 10_000]) {
		assert.equal(
			shouldRenderPlainShortChat({ enabled: true, promoted, messageCount }),
			false,
		);
	}
});

test("a growing stream cannot exceed the plain renderer hard limit", () => {
	const promoted = shouldInitializeShortChatPromoted({
		enabled: true,
		messageCount: 8,
		streaming: true,
	});
	assert.equal(promoted, false);
	assert.equal(
		shouldRenderPlainShortChat({
			enabled: true,
			promoted,
			messageCount: PLAIN_SHORT_CHAT_HARD_MAX_MESSAGES + 1,
		}),
		false,
	);
});

test("empty and bounded short chats keep the cheap plain path", () => {
	for (const messageCount of [0, 8, 10, PLAIN_SHORT_CHAT_HARD_MAX_MESSAGES]) {
		assert.equal(
			shouldRenderPlainShortChat({
				enabled: true,
				promoted: false,
				messageCount,
			}),
			true,
		);
	}
});

test("promotion and the plain-path opt-out remain authoritative", () => {
	for (const messageCount of [0, 8, 10_000]) {
		assert.equal(
			shouldRenderPlainShortChat({
				enabled: true,
				promoted: true,
				messageCount,
			}),
			false,
		);
		assert.equal(
			shouldRenderPlainShortChat({
				enabled: false,
				promoted: false,
				messageCount,
			}),
			false,
		);
	}
});
