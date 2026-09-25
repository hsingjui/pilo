import assert from "node:assert/strict";
import test from "node:test";

import {
	createConversationState,
	reduceConversation,
} from "../src/lib/conversation-reducer.ts";
import {
	coalesceConversationActions,
	reduceConversationActions,
	replayConversationEvents,
	replayConversationEventsBatched,
} from "../src/lib/conversation-replay.ts";
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
	assert.equal(
		state.messages.some((message) => message.role === "user" && message.queued),
		false,
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
		{ type: "local_assistant_pending", timestampMs: 1, replyRunwayPx: 192 },
		{ type: "user_message_start", text: "start", timestampMs: 2 },
		{ type: "assistant_text_delta", delta: "working", timestampMs: 2 },
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
	const queuedUser = state.messages.at(-2);
	assert.equal(queuedUser?.role, "user");
	assert.equal(queuedUser?.id, "q1");
	const continuedAssistant = state.messages.find(
		(message) => message.role === "assistant" && message.text === "working",
	);
	assert.equal(continuedAssistant?.role, "assistant");
	if (continuedAssistant?.role === "assistant") {
		assert.equal(continuedAssistant.completion, "continued");
	}
	const nextAssistant = state.messages.at(-1);
	if (nextAssistant?.role !== "assistant") throw new Error("assistant missing");
	assert.equal(nextAssistant.replyRunwayPx, 192);
	const before = state;
	state = reduceConversation(
		state,
		{ type: "local_user_queue_failed", clientMessageId: "q1" },
		ctx,
	);
	assert.equal(state, before);
});

test("an in-turn user message keeps the preceding assistant segment marked as continued", () => {
	const state = reduce([
		{ type: "user_message_start", text: "start", timestampMs: 1 },
		{ type: "assistant_message_start", timestampMs: 2 },
		{ type: "assistant_text_delta", delta: "working", timestampMs: 3 },
		{ type: "user_message_start", text: "adjust", timestampMs: 4 },
	]);
	const previousAssistant = state.messages[1];
	assert.equal(previousAssistant?.role, "assistant");
	if (previousAssistant?.role !== "assistant") {
		throw new Error("assistant missing");
	}
	assert.equal(previousAssistant.completion, "continued");
	assert.equal(previousAssistant.streaming, false);
	assert.equal(state.messages[2]?.role, "user");
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

test("batched assistant updates preserve sequential reducer semantics", () => {
	const ctx = context();
	let initial = createConversationState();
	for (const action of [
		{
			type: "local_user_submit",
			clientMessageId: "u1",
			text: "run",
			timestampMs: 1,
		},
		{ type: "local_assistant_pending", timestampMs: 1 },
		{ type: "user_message_start", text: "run", timestampMs: 2 },
	] satisfies ConversationAction[]) {
		initial = reduceConversation(initial, action, ctx);
	}

	const updates = [
		{ type: "assistant_message_start", timestampMs: 3 },
		{ type: "assistant_text_delta", delta: "hel", timestampMs: 4 },
		{ type: "assistant_text_delta", delta: "lo", timestampMs: 5 },
		{ type: "assistant_thinking_start", timestampMs: 6 },
		{ type: "assistant_thinking_delta", delta: "a", timestampMs: 7 },
		{ type: "assistant_thinking_delta", delta: "b", timestampMs: 8 },
		{ type: "assistant_thinking_end", timestampMs: 9 },
		{
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "pwd" },
			timestampMs: 10,
		},
		{
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "pwd" },
			partialResult: " /",
			timestampMs: 11,
		},
		{
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: "/repo",
			isError: false,
			timestampMs: 12,
		},
		{
			type: "assistant_turn_end",
			stopReason: "stop",
			completion: "complete",
			timestampMs: 13,
		},
	] satisfies ConversationAction[];
	const sequential = updates.reduce(
		(state, action) => reduceConversation(state, action, ctx),
		initial,
	);
	const batched = reduceConversationActions(initial, updates, ctx);
	assert.deepEqual(semanticMessages(batched), semanticMessages(sequential));
	assert.deepEqual(batched.active, sequential.active);
	assert.deepEqual(batched.pendingUsers, sequential.pendingUsers);
});

test("frame coalescing merges only compatible high-frequency actions", () => {
	const actions = [
		{
			type: "assistant_text_delta",
			delta: "a",
			sourceEntryId: "a1",
			sourceContentIndex: 0,
		},
		{
			type: "assistant_text_delta",
			delta: "b",
			sourceEntryId: "a1",
			sourceContentIndex: 0,
		},
		{
			type: "assistant_text_delta",
			delta: "c",
			sourceEntryId: "a2",
			sourceContentIndex: 0,
		},
		{ type: "assistant_thinking_delta", delta: "x" },
		{ type: "assistant_thinking_delta", delta: "y" },
		{
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "bash",
			args: {},
			partialResult: "old",
		},
		{
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "bash",
			args: {},
			partialResult: "latest",
		},
	] satisfies ConversationAction[];
	const result = coalesceConversationActions(actions);
	assert.equal(result.length, 4);
	assert.deepEqual(
		result.map((action) => action.type),
		[
			"assistant_text_delta",
			"assistant_text_delta",
			"assistant_thinking_delta",
			"tool_execution_update",
		],
	);
	assert.equal(
		result[0]?.type === "assistant_text_delta" ? result[0].delta : null,
		"ab",
	);
	assert.equal(
		result[2]?.type === "assistant_thinking_delta" ? result[2].delta : null,
		"xy",
	);
	assert.equal(
		result[3]?.type === "tool_execution_update"
			? result[3].partialResult
			: null,
		"latest",
	);
});

test("compaction marker closes the running turn and inserts a compaction message", () => {
	const state = replayConversationEvents(
		[
			{
				type: "user_message_start",
				text: "go",
				timestampMs: 1,
				sourceEntryId: "u1",
			},
			{ type: "assistant_message_start", timestampMs: 2, sourceEntryId: "a1" },
			{
				type: "assistant_text_delta",
				delta: "work",
				timestampMs: 2,
				sourceEntryId: "a1",
				sourceContentIndex: 0,
			},
			{
				type: "compaction_marker",
				summary: "summary text",
				tokensBefore: 217_975,
			},
			{
				type: "user_message_start",
				text: "continue",
				timestampMs: 9,
				sourceEntryId: "u2",
			},
		] satisfies ConversationEvent[],
		context(),
	);

	assert.deepEqual(
		state.messages.map((message) => message.role),
		["user", "assistant", "compaction", "user"],
	);
	const assistant = state.messages[1];
	assert.equal(assistant?.role, "assistant");
	if (assistant?.role !== "assistant") throw new Error("expected assistant");
	assert.equal(assistant.completion, "continued");
	const compaction = state.messages[2];
	assert.equal(compaction?.role, "compaction");
	if (compaction?.role !== "compaction") throw new Error("expected compaction");
	assert.equal(compaction.text, "summary text");
	assert.equal(compaction.tokensBefore, 217_975);
});
