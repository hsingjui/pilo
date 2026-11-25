import {
	createConversationState,
	isAssistantBatchAction,
	reduceConversation,
} from "./conversation-reducer.ts";
import type {
	ConversationAction,
	ConversationEvent,
	ConversationReducerContext,
	ConversationState,
} from "./conversation-types.ts";

/** Appends `action`, merging it into the trailing action when both coalesce. */
export function pushCoalescedConversationAction(
	result: ConversationAction[],
	action: ConversationAction,
) {
	const previous = result[result.length - 1];
	if (
		previous?.type === "assistant_text_delta" &&
		action.type === "assistant_text_delta" &&
		previous.sourceEntryId === action.sourceEntryId &&
		previous.sourceContentIndex === action.sourceContentIndex
	) {
		result[result.length - 1] = {
			...action,
			delta: previous.delta + action.delta,
		};
		return;
	}
	if (
		previous?.type === "assistant_thinking_delta" &&
		action.type === "assistant_thinking_delta" &&
		previous.sourceEntryId === action.sourceEntryId &&
		previous.sourceContentIndex === action.sourceContentIndex
	) {
		result[result.length - 1] = {
			...action,
			timestampMs: previous.timestampMs,
			delta: previous.delta + action.delta,
		};
		return;
	}
	if (
		previous?.type === "tool_execution_update" &&
		action.type === "tool_execution_update" &&
		previous.toolCallId === action.toolCallId
	) {
		result[result.length - 1] = action;
		return;
	}
	result.push(action);
}

export function coalesceConversationActions(
	actions: readonly ConversationAction[],
): ConversationAction[] {
	const result: ConversationAction[] = [];
	for (const action of actions) {
		pushCoalescedConversationAction(result, action);
	}
	return result;
}

function activeAssistantIndex(state: ConversationState) {
	const activeId = state.active?.assistantMessageId;
	if (!activeId) return -1;
	const lastIndex = state.messages.length - 1;
	if (
		state.messages[lastIndex]?.id === activeId &&
		state.messages[lastIndex]?.role === "assistant"
	) {
		return lastIndex;
	}
	return state.messages.findIndex(
		(message) => message.id === activeId && message.role === "assistant",
	);
}

function reduceActiveAssistantRun(
	state: ConversationState,
	actions: readonly ConversationAction[],
	context: ConversationReducerContext,
): ConversationState {
	const assistantIndex = activeAssistantIndex(state);
	const assistantMessage = state.messages[assistantIndex];
	if (
		state.pendingUsers[0]?.previousTurn ||
		assistantIndex < 0 ||
		assistantMessage?.role !== "assistant"
	) {
		return actions.reduce(
			(next, action) => reduceConversation(next, action, context),
			state,
		);
	}

	let compactState: ConversationState = {
		...state,
		messages: [assistantMessage],
	};
	for (const action of actions) {
		compactState = reduceConversation(compactState, action, context);
	}
	if (compactState.messages.length !== 1) {
		return actions.reduce(
			(next, action) => reduceConversation(next, action, context),
			state,
		);
	}

	const messages = state.messages.slice();
	messages[assistantIndex] = compactState.messages[0];
	return { ...compactState, messages };
}

export function reduceConversationActions(
	state: ConversationState,
	actions: readonly ConversationAction[],
	context: ConversationReducerContext,
): ConversationState {
	let next = state;
	let index = 0;
	while (index < actions.length) {
		const action = actions[index];
		if (!isAssistantBatchAction(action) || activeAssistantIndex(next) < 0) {
			next = reduceConversation(next, action, context);
			index += 1;
			continue;
		}

		let end = index + 1;
		while (end < actions.length && isAssistantBatchAction(actions[end])) {
			end += 1;
			if (actions[end - 1].type === "assistant_turn_end") break;
		}
		next = reduceActiveAssistantRun(next, actions.slice(index, end), context);
		index = end;
	}
	return next;
}

export function replayConversationEvents(
	events: ConversationEvent[],
	context: ConversationReducerContext,
	initialState = createConversationState(),
): ConversationState {
	return reduceConversationActions(initialState, events, context);
}

function yieldReplayWork(): Promise<void> {
	const scheduler = (
		globalThis as typeof globalThis & {
			scheduler?: { yield?: () => Promise<void> };
		}
	).scheduler;
	if (scheduler?.yield) return scheduler.yield();
	return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function replayConversationEventsBatched(
	events: ConversationEvent[],
	context: ConversationReducerContext,
	options: {
		maxEventsPerBatch?: number;
		onBatch?: (state: ConversationState) => void;
	} = {},
	initialState = createConversationState(),
): Promise<ConversationState> {
	const batchSize = Math.max(1, options.maxEventsPerBatch ?? 400);

	const replayBatch = async (
		offset: number,
		state: ConversationState,
	): Promise<ConversationState> => {
		if (offset >= events.length) return state;
		const end = Math.min(offset + batchSize, events.length);
		const next = reduceConversationActions(
			state,
			events.slice(offset, end),
			context,
		);
		options.onBatch?.(next);
		if (end >= events.length) return next;
		await yieldReplayWork();
		return replayBatch(end, next);
	};

	return replayBatch(0, initialState);
}

function reviveExternalActivity<
	T extends {
		type: string;
		status?: "complete" | "running";
		result?: unknown;
	},
>(item: T): T {
	return item.type === "tool" && item.result === undefined
		? { ...item, status: "running" }
		: item;
}

/**
 * Shows the saved history's unfinished last reply as still running, for a
 * session whose turn an external Pi is running: the reply is live, not
 * interrupted, and its tools without a result are still at work.
 */
export function markExternalTurnLive(
	state: ConversationState,
): ConversationState {
	if (state.active) return state;
	const index = state.messages.length - 1;
	const message = state.messages[index];
	if (message?.role !== "assistant" || message.completion !== "interrupted")
		return state;
	const messages = state.messages.slice();
	messages[index] = {
		...message,
		content: message.content?.map(reviveExternalActivity),
		activity: message.activity?.map(reviveExternalActivity),
		streaming: true,
		completion: undefined,
		errorMessage: undefined,
	};
	return {
		...state,
		messages,
		active: {
			turnStartedAtMs: message.workStartedAtMs ?? message.timestampMs,
			assistantUpdatedAtMs: message.timestampMs,
			assistantMessageId: message.id,
			firstRuntimeUserSeen: false,
		},
	};
}
