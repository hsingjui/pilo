import assert from "node:assert/strict";
import test from "node:test";

import { createConversationState } from "../src/lib/conversation-reducer.ts";
import {
	getActiveStreamingPresentationChars,
	getStreamingPresentationIntervalMs,
} from "../src/lib/chat-stream-presentation.ts";

test("streaming presentation cadence slows as the growing tail gets larger", () => {
	assert.equal(getStreamingPresentationIntervalMs(0), 50);
	assert.equal(getStreamingPresentationIntervalMs(1_500), 50);
	assert.equal(getStreamingPresentationIntervalMs(1_501), 75);
	assert.equal(getStreamingPresentationIntervalMs(6_001), 100);
	assert.equal(getStreamingPresentationIntervalMs(16_001), 125);
});

test("active presentation size includes visible text and running thinking", () => {
	const state = createConversationState([
		{
			id: "assistant-1",
			role: "assistant",
			text: "hello",
			time: "",
			streaming: true,
			content: [
				{ id: "text-1", type: "text", text: "hello" },
				{
					id: "thinking-1",
					type: "thinking",
					text: "thinking",
					status: "running",
				},
			],
		},
	]);
	state.active = {
		assistantMessageId: "assistant-1",
		firstRuntimeUserSeen: false,
	};
	assert.equal(getActiveStreamingPresentationChars(state), 13);
	assert.equal(getActiveStreamingPresentationChars(undefined), 0);
});
