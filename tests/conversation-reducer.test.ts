import assert from "node:assert/strict";
import test from "node:test";

import {
	createConversationState,
	reduceConversation,
	replayConversationEvents,
	replayConversationEventsBatched,
} from "../src/lib/conversation-reducer.ts";
import type {
	ConversationAction,
	ConversationEvent,
	ConversationReducerContext,
} from "../src/lib/conversation-types.ts";

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

function reduce(actions: ConversationAction[]) {
	const ctx = context();
	return actions.reduce(
		(state, action) => reduceConversation(state, action, ctx),
		createConversationState(),
	);
}

function semanticMessages(state: ReturnType<typeof createConversationState>) {
	return state.messages.map((message) => {
		if (message.role === "user") {
			return { role: message.role, text: message.text, queued: message.queued };
		}
		return {
			role: message.role,
			text: message.text,
			streaming: message.streaming,
			completion: message.completion,
			stopReason: message.stopReason,
			content: message.content?.map((item) =>
				item.type === "tool"
					? {
							type: item.type,
							id: item.id,
							toolName: item.toolName,
							args: item.args,
							result: item.result,
							status: item.status,
							isError: item.isError,
						}
					: {
							type: item.type,
							text: item.text,
							status: "status" in item ? item.status : undefined,
						},
			),
		};
	});
}

test("history replay keeps one assistant UI message across multiple Pi assistant messages", () => {
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
	assert.equal(state.messages.length, 2);
	const assistant = state.messages[1];
	assert.equal(assistant?.role, "assistant");
	if (!assistant || assistant.role !== "assistant")
		throw new Error("assistant missing");
	assert.deepEqual(
		assistant.content?.map((item) => item.type),
		["thinking", "tool", "text"],
	);
	assert.equal(assistant.text, "done");
	assert.equal(assistant.streaming, false);
	assert.equal(assistant.completion, "complete");
});

test("live optimistic actions and replay events converge to the same semantic conversation", () => {
	const historyEvents: ConversationEvent[] = [
		{
			type: "user_message_start",
			text: "hello",
			timestampMs: 100,
			sourceEntryId: "u1",
		},
		{ type: "assistant_message_start", timestampMs: 101, sourceEntryId: "a1" },
		{
			type: "assistant_text_delta",
			delta: "world",
			timestampMs: 102,
			sourceEntryId: "a1",
			sourceContentIndex: 0,
		},
		{
			type: "assistant_turn_end",
			stopReason: "stop",
			completion: "complete",
			timestampMs: 103,
		},
	];
	const history = replayConversationEvents(historyEvents, context());
	const live = reduce([
		{
			type: "local_user_submit",
			clientMessageId: "client-u1",
			text: "hello",
			timestampMs: 100,
		},
		{ type: "local_assistant_pending", timestampMs: 100 },
		{ type: "user_message_start", text: "hello", timestampMs: 100 },
		{ type: "assistant_message_start", timestampMs: 101 },
		{ type: "assistant_text_delta", delta: "world", timestampMs: 102 },
		{
			type: "assistant_turn_end",
			stopReason: "stop",
			completion: "complete",
			timestampMs: 103,
		},
	]);
	assert.deepEqual(semanticMessages(live), semanticMessages(history));
});

test("queued messages use client ids so duplicate text can fail independently", () => {
	let state = reduce([
		{
			type: "local_user_submit",
			clientMessageId: "u0",
			text: "start",
			timestampMs: 1,
		},
		{ type: "local_assistant_pending", timestampMs: 1 },
		{ type: "user_message_start", text: "start", timestampMs: 1 },
		{
			type: "local_user_queue",
			clientMessageId: "q1",
			text: "继续",
			queueKind: "follow_up",
			timestampMs: 2,
		},
		{
			type: "local_user_queue",
			clientMessageId: "q2",
			text: "继续",
			queueKind: "follow_up",
			timestampMs: 3,
		},
	]);
	state = reduceConversation(
		state,
		{ type: "local_user_queue_failed", clientMessageId: "q2" },
		context(),
	);
	const queued = state.messages.filter(
		(message) => message.role === "user" && message.queued,
	);
	assert.deepEqual(
		queued.map((message) => message.id),
		["q1"],
	);
	assert.deepEqual(
		state.pendingUsers.map((item) => item.clientMessageId),
		["q1"],
	);
});

test("interrupted historical EOF remains visibly interrupted", () => {
	const state = replayConversationEvents(
		[
			{ type: "user_message_start", text: "run", timestampMs: 1 },
			{ type: "assistant_message_start", timestampMs: 2 },
			{
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: {},
				timestampMs: 3,
			},
			{
				type: "assistant_turn_end",
				stopReason: "toolUse",
				completion: "interrupted",
				timestampMs: 4,
			},
		],
		context(),
	);
	const assistant = state.messages[1];
	if (!assistant || assistant.role !== "assistant")
		throw new Error("assistant missing");
	assert.equal(assistant.completion, "interrupted");
	assert.equal(assistant.streaming, false);
});

test("queued acknowledgement creates the next pending assistant and ignores late failure", () => {
	const ctx = context();
	let state = createConversationState();
	for (const action of [
		{
			type: "local_user_submit",
			clientMessageId: "u0",
			text: "start",
			timestampMs: 1,
		},
		{ type: "local_assistant_pending", timestampMs: 1 },
		{ type: "user_message_start", text: "start", timestampMs: 2 },
		{
			type: "local_user_queue",
			clientMessageId: "q1",
			text: "next",
			queueKind: "follow_up",
			timestampMs: 3,
		},
		{ type: "user_message_start", text: "next", timestampMs: 4 },
	] satisfies ConversationAction[]) {
		state = reduceConversation(state, action, ctx);
	}
	assert.equal(state.pendingUsers.length, 0);
	assert.equal(state.messages.at(-1)?.role, "assistant");
	const before = state;
	state = reduceConversation(
		state,
		{ type: "local_user_queue_failed", clientMessageId: "q1" },
		ctx,
	);
	assert.equal(state, before);
});

test("batched replay preserves the provided initial state", async () => {
	const initial = createConversationState([
		{
			id: "existing",
			role: "user",
			text: "existing",
			time: "0",
		},
	]);
	const state = await replayConversationEventsBatched(
		[
			{
				type: "user_message_start",
				text: "next",
				timestampMs: 1,
			},
		],
		context(),
		{},
		initial,
	);
	assert.deepEqual(
		state.messages.map((message) => message.text),
		["existing", "next"],
	);
});
