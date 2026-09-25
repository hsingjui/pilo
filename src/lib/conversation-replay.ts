import {
	createConversationState,
	reduceConversation,
} from "./conversation-reducer.ts";
import type {
	ConversationAction,
	ConversationEvent,
	ConversationReducerContext,
	ConversationState,
} from "./conversation-types.ts";

export function coalesceConversationActions(
	actions: readonly ConversationAction[],
): ConversationAction[] {
	const result: ConversationAction[] = [];
	for (const action of actions) {
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
			continue;
		}
		if (
			previous?.type === "assistant_thinking_delta" &&
			action.type === "assistant_thinking_delta" &&
			previous.sourceEntryId === action.sourceEntryId &&
			previous.sourceContentIndex === action.sourceContentIndex
		) {
			result[result.length - 1] = {
				...action,
				delta: previous.delta + action.delta,
			};
			continue;
		}
		if (
			previous?.type === "tool_execution_update" &&
			action.type === "tool_execution_update" &&
			previous.toolCallId === action.toolCallId
		) {
			result[result.length - 1] = action;
			continue;
		}
		result.push(action);
	}
	return result;
}

function isAssistantBatchAction(action: ConversationAction) {
	return (
		action.type === "assistant_message_start" ||
		action.type === "assistant_text_delta" ||
		action.type === "assistant_text_snapshot" ||
		action.type === "assistant_thinking_start" ||
		action.type === "assistant_thinking_delta" ||
		action.type === "assistant_thinking_end" ||
		action.type === "tool_execution_start" ||
		action.type === "tool_execution_update" ||
		action.type === "tool_execution_end" ||
		action.type === "assistant_turn_end"
	);
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
	if (assistantIndex < 0 || assistantMessage?.role !== "assistant") {
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
