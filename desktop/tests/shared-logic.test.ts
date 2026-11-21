import { expect, test } from "nsh/test";

import {
	createConversationState,
	reduceConversation as reduceByRelativePath,
} from "@shared/chat/conversation-reducer.ts";
import { replayConversationEvents } from "@shared/chat/conversation-replay.ts";
import type {
	ConversationEvent,
	ConversationReducerContext,
} from "@shared/chat/conversation-types.ts";
import { reduceConversation } from "@shared/chat/conversation-reducer";

function context(): ConversationReducerContext {
	let messageId = 0;
	let contentId = 0;
	return {
		createMessageId: (kind) => `${kind}-${++messageId}`,
		createContentId: (kind) => `${kind}-${++contentId}`,
		now: () => 10_000,
		formatTime: (timestampMs) => String(timestampMs),
	};
}

test("history events replay into a message list", () => {
	const events: ConversationEvent[] = [
		{
			type: "user_message_start",
			text: "run",
			timestampMs: 1,
			sourceEntryId: "u1",
		},
		{ type: "assistant_message_start", timestampMs: 2, sourceEntryId: "a1" },
		{
			type: "assistant_thinking_start",
			timestampMs: 2,
			sourceEntryId: "a1",
			sourceContentIndex: 0,
		},
		{
			type: "assistant_thinking_delta",
			delta: "think",
			timestampMs: 2,
			sourceEntryId: "a1",
			sourceContentIndex: 0,
		},
		{
			type: "assistant_thinking_end",
			timestampMs: 2,
			sourceEntryId: "a1",
			sourceContentIndex: 0,
		},
		{
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "pwd" },
			timestampMs: 3,
		},
		{
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: "/repo",
			isError: false,
			timestampMs: 4,
		},
		{ type: "assistant_message_start", timestampMs: 5, sourceEntryId: "a2" },
		{
			type: "assistant_text_delta",
			delta: "done",
			timestampMs: 5,
			sourceEntryId: "a2",
			sourceContentIndex: 0,
		},
		{
			type: "assistant_turn_end",
			stopReason: "stop",
			completion: "complete",
			timestampMs: 6,
		},
	];
	const state = replayConversationEvents(events, context());
	expect(state.messages.length).toBe(2);
	const assistant = state.messages[1];
	if (assistant?.role !== "assistant") throw new Error("assistant missing");
	expect(assistant.content?.map((item) => item.type)).toEqual([
		"thinking",
		"tool",
		"text",
	]);
	expect(assistant.text).toBe("done");
	expect(assistant.streaming).toBe(false);
});

test("the alias and the relative path reach the same module", () => {
	expect(reduceConversation).toBe(reduceByRelativePath);
	expect(createConversationState().messages).toEqual([]);
});
