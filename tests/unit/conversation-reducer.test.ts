import assert from "node:assert/strict";
import test from "node:test";

import type { PiloRuntimeEvent } from "../../src/lib/api/pi-runtime-types.ts";

import {
	createConversationState,
	reduceConversation,
} from "../../src/lib/chat/conversation-reducer.ts";
import {
	coalesceConversationActions,
	reduceConversationActions,
	replayConversationEvents,
	replayConversationEventsBatched,
} from "../../src/lib/chat/conversation-replay.ts";
import { toConversationAction } from "../../src/lib/chat/conversation-runtime-adapter.ts";
import type {
	ConversationAction,
	ConversationEvent,
	ConversationReducerContext,
} from "../../src/lib/chat/conversation-types.ts";

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

test("thinking actions keep the start and end timestamps of their block", () => {
	const state = reduce([
		{
			type: "local_user_submit",
			clientMessageId: "u1",
			text: "run",
			timestampMs: 1,
		},
		{ type: "local_assistant_pending", timestampMs: 1 },
		{ type: "user_message_start", text: "run", timestampMs: 2 },
		{ type: "assistant_message_start", timestampMs: 3 },
		{ type: "assistant_thinking_start", timestampMs: 4 },
		{ type: "assistant_thinking_delta", delta: "想", timestampMs: 5 },
		{ type: "assistant_thinking_end", timestampMs: 40 },
	]);
	const thinking = state.messages
		.flatMap((message) => message.content ?? [])
		.find((item) => item.type === "thinking");

	assert.deepEqual(
		thinking?.type === "thinking"
			? {
					text: thinking.text,
					status: thinking.status,
					startedAtMs: thinking.startedAtMs,
					endedAtMs: thinking.endedAtMs,
				}
			: null,
		{ text: "想", status: "complete", startedAtMs: 4, endedAtMs: 40 },
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

test("history replay keeps the turn token usage on the assistant message", () => {
	const state = replayConversationEvents(
		[
			{
				type: "user_message_start",
				text: "run",
				timestampMs: 1,
				sourceEntryId: "u1",
			},
			{ type: "assistant_message_start", timestampMs: 2, sourceEntryId: "a1" },
			{
				type: "assistant_text_delta",
				delta: "done",
				timestampMs: 3,
				sourceEntryId: "a1",
				sourceContentIndex: 0,
			},
			{
				type: "assistant_turn_end",
				stopReason: "stop",
				completion: "complete",
				timestampMs: 4,
				usage: {
					input: 10,
					output: 5,
					cacheRead: 20,
					cacheWrite: 2,
					total: 37,
					cost: 0.01,
				},
			},
		] satisfies ConversationEvent[],
		context(),
	);

	const assistant = state.messages[1];
	if (assistant?.role !== "assistant") throw new Error("expected assistant");
	assert.deepEqual(assistant.usage, {
		input: 10,
		output: 5,
		cacheRead: 20,
		cacheWrite: 2,
		total: 37,
		cost: 0.01,
	});
});

test("turns without reported usage keep the field empty", () => {
	const state = replayConversationEvents(
		[
			{
				type: "user_message_start",
				text: "run",
				timestampMs: 1,
				sourceEntryId: "u1",
			},
			{ type: "assistant_message_start", timestampMs: 2, sourceEntryId: "a1" },
			{
				type: "assistant_text_delta",
				delta: "done",
				timestampMs: 3,
				sourceEntryId: "a1",
				sourceContentIndex: 0,
			},
			{ type: "assistant_turn_end", stopReason: "stop", timestampMs: 4 },
		] satisfies ConversationEvent[],
		context(),
	);

	const assistant = state.messages[1];
	if (assistant?.role !== "assistant") throw new Error("expected assistant");
	assert.equal(assistant.usage, undefined);
});

test("usage-only runtime updates do not create an assistant message", () => {
	const usage = {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		total: 15,
	};
	const action = toConversationAction({
		type: "assistant_usage_update",
		generation: 1,
		usage,
		timestampMs: 1,
	});
	assert.deepEqual(action, {
		type: "assistant_usage_update",
		usage,
		timestampMs: 1,
	});
	if (!action) throw new Error("expected usage update");
	const state = createConversationState();
	assert.equal(reduceConversation(state, action, context()), state);
});

test("steering preserves prior usage without ending the run early", () => {
	const usage = {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		total: 15,
	};
	const actions: ConversationAction[] = [
		{ type: "user_message_start", text: "go", timestampMs: 1 },
		{ type: "assistant_text_delta", delta: "first", timestampMs: 2 },
		{
			type: "local_user_queue",
			clientMessageId: "steer-1",
			text: "change direction",
			queueKind: "steer",
			timestampMs: 3,
		},
	];
	const ctx = context();
	const running = reduceConversationActions(
		createConversationState(),
		actions,
		ctx,
	);
	const updated = reduceConversation(
		running,
		{ type: "assistant_usage_update", usage },
		ctx,
	);
	assert.deepEqual(updated.active, running.active);
	assert.equal(updated.messages.length, running.messages.length);
	const first = updated.messages[1];
	if (first?.role !== "assistant") throw new Error("expected assistant");
	assert.deepEqual(first.usage, usage);
	assert.equal(first.streaming, true);
	assert.equal(first.completion, undefined);

	const remainder: ConversationAction[] = [
		{ type: "user_message_start", text: "change direction", timestampMs: 4 },
		{ type: "assistant_text_delta", delta: "second", timestampMs: 5 },
		{
			type: "assistant_turn_end",
			stopReason: "stop",
			timestampMs: 6,
			usage: { ...usage, input: 100, output: 50, total: 150 },
		},
	];
	const completed = reduceConversationActions(updated, remainder, ctx);
	const assistants = completed.messages.filter(
		(message) => message.role === "assistant",
	);
	assert.deepEqual(
		assistants.map((message) => message.usage?.total),
		[15, 150],
	);
	assert.deepEqual(
		assistants.map((message) => message.completion),
		["continued", "complete"],
	);
	assert.equal(completed.active, null);
	assert.deepEqual(
		reduceConversationActions(
			createConversationState(),
			[...actions, { type: "assistant_usage_update", usage }, ...remainder],
			context(),
		),
		completed,
	);
});

test("usage before a pending user echo belongs to the previous assistant", () => {
	const usage = {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		total: 15,
	};
	const ctx = context();
	const pending = reduceConversationActions(
		createConversationState(),
		[
			{ type: "user_message_start", text: "go", timestampMs: 1 },
			{ type: "assistant_text_delta", delta: "first", timestampMs: 2 },
			{
				type: "local_user_submit",
				clientMessageId: "next-user",
				text: "next",
				timestampMs: 3,
			},
			{ type: "local_assistant_pending", timestampMs: 3 },
		],
		ctx,
	);
	const updated = reduceConversationActions(
		pending,
		[{ type: "assistant_usage_update", usage }],
		ctx,
	);
	assert.equal(updated.active, pending.active);
	assert.equal(updated.messages.length, pending.messages.length);
	const previous = updated.messages[1];
	const next = updated.messages[3];
	if (previous?.role !== "assistant" || next?.role !== "assistant")
		throw new Error("expected previous and pending assistants");
	assert.deepEqual(previous.usage, usage);
	assert.equal(next.usage, undefined);
	assert.equal(next.streaming, true);
});

test("live assistant_message_end carries usage into the turn end action", () => {
	const action = toConversationAction({
		type: "assistant_message_end",
		generation: 1,
		stopReason: "stop",
		errorMessage: null,
		usage: { input: 3, output: 7, cacheRead: 40, cacheWrite: 0, total: 50 },
	});

	if (action?.type !== "assistant_turn_end")
		throw new Error("expected turn end");
	assert.equal(action.usage?.total, 50);
	assert.equal(action.usage?.cacheRead, 40);
});

test("thinking without event timestamps does not use the processing clock", () => {
	let currentTime = 1000;
	const customCtx = {
		...context(),
		now: () => currentTime,
	};
	let state = reduceConversation(
		createConversationState(),
		{
			type: "local_user_submit",
			clientMessageId: "u1",
			text: "hi",
			timestampMs: currentTime,
		},
		customCtx,
	);
	state = reduceConversation(
		state,
		{ type: "user_message_start", text: "hi" },
		customCtx,
	);
	currentTime = 1500;
	state = reduceConversation(
		state,
		{ type: "assistant_thinking_start" },
		customCtx,
	);
	currentTime = 5500;
	state = reduceConversation(
		state,
		{ type: "assistant_thinking_end" },
		customCtx,
	);

	const assistant = state.messages[1];
	if (assistant?.role !== "assistant") throw new Error("expected assistant");
	const thinking = assistant.content?.find((item) => item.type === "thinking");
	assert.ok(thinking);
	assert.equal(thinking.status, "complete");
	assert.equal(thinking.startedAtMs, undefined);
	assert.equal(thinking.endedAtMs, undefined);
});

test("buffered runtime thinking events keep their Host timestamps through the adapter", () => {
	const events: PiloRuntimeEvent[] = [
		{ type: "assistant_thinking_start", generation: 1, timestampMs: 1_000 },
		{
			type: "assistant_thinking_delta",
			generation: 1,
			delta: "thinking",
			timestampMs: 2_000,
		},
		{ type: "assistant_thinking_end", generation: 1, timestampMs: 31_000 },
	];
	const actions = events.map((event) => {
		const action = toConversationAction(event);
		assert.ok(action);
		return action;
	});
	const state = reduceConversationActions(
		createConversationState(),
		coalesceConversationActions(actions),
		{ ...context(), now: () => 90_000 },
	);
	const assistant = state.messages[0];
	assert.equal(assistant.role, "assistant");
	if (assistant.role !== "assistant") throw new Error("expected assistant");
	const thinking = assistant.content?.find((item) => item.type === "thinking");
	assert.ok(thinking);
	assert.equal(thinking.startedAtMs, 1_000);
	assert.equal(thinking.endedAtMs, 31_000);
	assert.equal(thinking.endedAtMs - thinking.startedAtMs, 30_000);
});

test("coalesced thinking deltas preserve the first timestamp without a start event", () => {
	for (const timestampMs of [1_000, undefined]) {
		const actions: ConversationAction[] = [
			{ type: "assistant_thinking_delta", delta: "a", timestampMs },
			{ type: "assistant_thinking_delta", delta: "b", timestampMs: 4_000 },
			{ type: "assistant_thinking_end", timestampMs: 5_000 },
		];
		const sequential = reduce(actions);
		const coalesced = reduceConversationActions(
			createConversationState(),
			coalesceConversationActions(actions),
			context(),
		);
		const assistant = coalesced.messages[0];
		if (assistant?.role !== "assistant") throw new Error("expected assistant");
		const thinking = assistant.content?.find(
			(item) => item.type === "thinking",
		);
		assert.ok(thinking);
		const sequentialAssistant = sequential.messages[0];
		if (sequentialAssistant?.role !== "assistant")
			throw new Error("expected assistant");
		assert.deepEqual(thinking, sequentialAssistant.content?.[0]);
		assert.equal(thinking.text, "ab");
		assert.equal(thinking.status, "complete");
		assert.equal(thinking.startedAtMs, timestampMs);
		assert.equal(thinking.endedAtMs, 5_000);
		if (timestampMs !== undefined) {
			assert.ok(thinking.startedAtMs !== undefined);
			assert.ok(thinking.endedAtMs !== undefined);
			assert.equal(thinking.endedAtMs - thinking.startedAtMs, 4_000);
		}
	}
});

test("thinking with missing boundaries never mixes Host and processing clocks", () => {
	const cases: ConversationAction[][] = [
		[
			{ type: "assistant_thinking_start", timestampMs: 1_000 },
			{ type: "assistant_thinking_end" },
		],
		[
			{ type: "assistant_thinking_start" },
			{ type: "assistant_thinking_end", timestampMs: 31_000 },
		],
		[
			{ type: "assistant_thinking_delta", delta: "legacy" },
			{ type: "assistant_thinking_end", timestampMs: 31_000 },
		],
	];
	for (const actions of cases) {
		const state = reduce(actions);
		const assistant = state.messages[0];
		if (assistant.role !== "assistant") throw new Error("expected assistant");
		const thinking = assistant.content?.find(
			(item) => item.type === "thinking",
		);
		assert.ok(thinking);
		assert.ok(
			thinking.startedAtMs === undefined || thinking.endedAtMs === undefined,
		);
	}
});
