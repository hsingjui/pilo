import {
	appendAssistantTextContent,
	appendAssistantThinkingContent,
	finishAssistantThinkingContent,
	reconcileAssistantTextContent,
	startAssistantThinkingContent,
	upsertToolContent,
	type AssistantContentItem,
} from "./chat-activity-state.ts";
import type {
	ChatMessage,
	ConversationAction,
	ConversationEvent,
	ConversationReducerContext,
	ConversationState,
} from "./conversation-types.ts";

type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

export function createConversationState(
	messages: ChatMessage[] = [],
): ConversationState {
	return { messages, active: null, pendingUsers: [] };
}

function assistantText(content: AssistantContentItem[] | undefined): string {
	return (content ?? [])
		.filter(
			(item): item is Extract<AssistantContentItem, { type: "text" }> =>
				item.type === "text",
		)
		.map((item) => item.text)
		.join("");
}

function finishContent(
	content: AssistantContentItem[] | undefined,
): AssistantContentItem[] | undefined {
	return content?.map((item) =>
		item.type === "text" ? item : { ...item, status: "complete" as const },
	);
}

function ensureActive(
	state: ConversationState,
	timestampMs: number | undefined,
): ConversationState {
	if (state.active) {
		if (timestampMs === undefined) return state;
		return {
			...state,
			active: { ...state.active, assistantUpdatedAtMs: timestampMs },
		};
	}
	return {
		...state,
		active: {
			turnStartedAtMs: timestampMs,
			assistantUpdatedAtMs: timestampMs,
			firstRuntimeUserSeen: false,
		},
	};
}

function withAssistant(
	state: ConversationState,
	context: ConversationReducerContext,
	timestampMs: number | undefined,
	update: (message: AssistantMessage) => AssistantMessage,
): ConversationState {
	let next = ensureActive(state, timestampMs);
	let id = next.active?.assistantMessageId;
	const lastIndex = next.messages.length - 1;
	let index =
		id && next.messages[lastIndex]?.id === id
			? lastIndex
			: id
				? next.messages.findIndex((message) => message.id === id)
				: -1;
	if (index < 0) {
		id = context.createMessageId("assistant");
		const assistant: AssistantMessage = {
			id,
			role: "assistant",
			text: "",
			time: context.formatTime(timestampMs ?? context.now()),
			timestampMs,
			streaming: true,
		};
		const messages = [...next.messages, update(assistant)];
		return {
			...next,
			messages,
			active: { ...next.active!, assistantMessageId: id },
		};
	}
	const current = next.messages[index];
	if (!current || current.role !== "assistant") return next;
	const messages = [...next.messages];
	messages[index] = update(current);
	return { ...next, messages };
}

function endTurn(
	state: ConversationState,
	stopReason: string | null | undefined,
	errorMessage: string | null | undefined,
	timestampMs: number,
	completion: "complete" | "interrupted" | "continued" = "complete",
): ConversationState {
	if (!state.active?.assistantMessageId) return { ...state, active: null };
	const index = state.messages.findIndex(
		(message) => message.id === state.active?.assistantMessageId,
	);
	if (index < 0) return { ...state, active: null };
	const current = state.messages[index];
	if (!current || current.role !== "assistant")
		return { ...state, active: null };
	const startedAt = state.active.turnStartedAtMs;
	const visibleError =
		stopReason === "aborted"
			? undefined
			: errorMessage?.trim() ||
				(stopReason === "error"
					? "Pi 返回了错误结果。"
					: completion === "interrupted"
						? "这段历史回复在完成前中断。"
						: undefined);
	const messages = [...state.messages];
	messages[index] = {
		...current,
		text: assistantText(current.content) || current.text,
		content: finishContent(current.content),
		activity: current.activity?.map((item) =>
			item.type === "thinking"
				? {
						id: item.id,
						type: item.type,
						text: item.text,
						status: "complete" as const,
					}
				: {
						id: item.id,
						type: item.type,
						toolName: item.toolName,
						args: item.args,
						result: item.result,
						status: "complete" as const,
						isError: item.isError,
					},
		),
		streaming: false,
		workDurationMs:
			completion === "continued" || startedAt === undefined
				? undefined
				: Math.max(0, timestampMs - startedAt),
		stopReason: stopReason ?? undefined,
		errorMessage: visibleError,
		completion,
	};
	return { ...state, messages, active: null };
}

export function reduceConversation(
	state: ConversationState,
	action: ConversationAction,
	context: ConversationReducerContext,
): ConversationState {
	switch (action.type) {
		case "local_user_submit": {
			const message: ChatMessage = {
				id: action.clientMessageId,
				role: "user",
				text: action.text,
				images: action.images,
				time: context.formatTime(action.timestampMs),
				timestampMs: action.timestampMs,
			};
			return {
				...state,
				messages:
					action.appendMessage === false
						? state.messages
						: [...state.messages, message],
				active: {
					turnStartedAtMs: action.timestampMs,
					assistantUpdatedAtMs: action.timestampMs,
					firstRuntimeUserSeen: false,
				},
				pendingUsers: [
					...state.pendingUsers,
					{
						clientMessageId: action.clientMessageId,
						text: action.text,
						images: action.images,
						timestampMs: action.timestampMs,
					},
				],
			};
		}
		case "local_user_queue":
			return {
				...state,
				pendingUsers: [
					...state.pendingUsers,
					{
						clientMessageId: action.clientMessageId,
						text: action.text,
						images: action.images,
						timestampMs: action.timestampMs,
						queueKind: action.queueKind,
					},
				],
			};
		case "local_user_queue_failed": {
			if (
				!state.pendingUsers.some(
					(item) => item.clientMessageId === action.clientMessageId,
				)
			) {
				return state;
			}
			return {
				...state,
				messages: state.messages.filter(
					(message) => message.id !== action.clientMessageId,
				),
				pendingUsers: state.pendingUsers.filter(
					(item) => item.clientMessageId !== action.clientMessageId,
				),
			};
		}
		case "local_assistant_pending":
			return withAssistant(state, context, action.timestampMs, (message) => ({
				...message,
				streaming: true,
				replyRunwayPx: action.replyRunwayPx,
			}));
		case "local_turn_abort":
			return endTurn(state, "aborted", null, action.timestampMs);
		case "conversation_runtime_error":
			return endTurn(state, "error", action.message, action.timestampMs);
		case "compaction_marker": {
			const timestampMs = action.timestampMs ?? context.now();
			const next = state.active?.assistantMessageId
				? endTurn(state, undefined, undefined, timestampMs, "continued")
				: state;
			return {
				...next,
				messages: [
					...next.messages,
					{
						id: action.sourceEntryId ?? context.createMessageId("compaction"),
						role: "compaction",
						text: action.summary,
						tokensBefore: action.tokensBefore,
						time: context.formatTime(timestampMs),
						timestampMs: action.timestampMs,
					},
				],
			};
		}
		case "user_message_start": {
			const pending = state.pendingUsers[0];
			if (pending) {
				let next = state;
				if (pending.queueKind) {
					const currentActive = state.active;
					let replyRunwayPx: number | undefined;
					if (currentActive?.assistantMessageId) {
						const currentAssistant = state.messages.find(
							(message) => message.id === currentActive.assistantMessageId,
						);
						if (currentAssistant?.role === "assistant") {
							replyRunwayPx = currentAssistant.replyRunwayPx;
						}
						next = endTurn(
							state,
							undefined,
							undefined,
							action.timestampMs ?? pending.timestampMs ?? context.now(),
							"continued",
						);
					}
					const startedAtMs =
						action.timestampMs ?? pending.timestampMs ?? context.now();
					next = {
						...next,
						messages: [
							...next.messages,
							{
								id: pending.clientMessageId,
								role: "user",
								text: action.text,
								images: pending.images,
								time: context.formatTime(startedAtMs),
								timestampMs: startedAtMs,
							},
						],
						active: {
							turnStartedAtMs: startedAtMs,
							assistantUpdatedAtMs: action.timestampMs,
							firstRuntimeUserSeen: true,
						},
					};
					next = withAssistant(next, context, startedAtMs, (message) => ({
						...message,
						streaming: true,
						replyRunwayPx,
					}));
				}
				if (!pending.queueKind) {
					next = {
						...next,
						active: next.active
							? {
									...next.active,
									turnStartedAtMs: action.timestampMs ?? context.now(),
									firstRuntimeUserSeen: true,
								}
							: next.active,
					};
				}
				return { ...next, pendingUsers: next.pendingUsers.slice(1) };
			}
			const timestampMs = action.timestampMs ?? context.now();
			let next = state;
			if (state.active?.assistantMessageId) {
				next = endTurn(state, undefined, undefined, timestampMs, "continued");
			}
			return {
				...next,
				messages: [
					...next.messages,
					{
						id: action.sourceEntryId ?? context.createMessageId("user"),
						role: "user",
						text: action.text,
						images: action.images,
						time: context.formatTime(timestampMs),
						timestampMs: action.timestampMs,
					},
				],
				active: {
					turnStartedAtMs: timestampMs,
					assistantUpdatedAtMs: action.timestampMs,
					firstRuntimeUserSeen: true,
				},
			};
		}
		case "assistant_message_start":
			return withAssistant(
				state,
				context,
				action.timestampMs,
				(message) => message,
			);
		case "assistant_text_delta":
			return withAssistant(state, context, action.timestampMs, (message) => {
				const content = appendAssistantTextContent(
					message.content,
					action.delta,
					() =>
						action.sourceEntryId
							? `${action.sourceEntryId}:content:${action.sourceContentIndex ?? 0}`
							: context.createContentId("text"),
				);
				return {
					...message,
					content,
					text: message.text + action.delta,
					streaming: true,
				};
			});
		case "assistant_text_snapshot":
			return withAssistant(state, context, action.timestampMs, (message) => {
				const content = reconcileAssistantTextContent(
					message.content,
					action.text,
					() => context.createContentId("text"),
				);
				return { ...message, content, text: action.text, streaming: true };
			});
		case "assistant_thinking_start":
			return withAssistant(state, context, action.timestampMs, (message) => ({
				...message,
				content: startAssistantThinkingContent(message.content, () =>
					action.sourceEntryId
						? `${action.sourceEntryId}:content:${action.sourceContentIndex ?? 0}`
						: context.createContentId("thinking"),
				),
				streaming: true,
			}));
		case "assistant_thinking_delta":
			return withAssistant(state, context, action.timestampMs, (message) => ({
				...message,
				content: appendAssistantThinkingContent(
					message.content,
					action.delta,
					() => context.createContentId("thinking"),
				),
				streaming: true,
			}));
		case "assistant_thinking_end":
			return withAssistant(state, context, action.timestampMs, (message) => ({
				...message,
				content: finishAssistantThinkingContent(message.content),
			}));
		case "tool_execution_start":
			return withAssistant(state, context, action.timestampMs, (message) => ({
				...message,
				content: upsertToolContent(
					message.content,
					action.toolCallId,
					() => ({
						id: action.toolCallId,
						type: "tool",
						toolName: action.toolName,
						args: action.args,
						status: "running",
					}),
					(current) => ({
						...current,
						toolName: action.toolName,
						args: action.args,
						status: "running",
						isError: false,
					}),
				),
				streaming: true,
			}));
		case "tool_execution_update":
			return withAssistant(state, context, action.timestampMs, (message) => ({
				...message,
				content: upsertToolContent(
					message.content,
					action.toolCallId,
					() => ({
						id: action.toolCallId,
						type: "tool",
						toolName: action.toolName,
						args: action.args,
						result: action.partialResult,
						status: "running",
					}),
					(current) => ({
						...current,
						toolName: action.toolName,
						args: action.args,
						result: action.partialResult,
						status: "running",
					}),
				),
			}));
		case "tool_execution_end":
			return withAssistant(state, context, action.timestampMs, (message) => ({
				...message,
				content: upsertToolContent(
					message.content,
					action.toolCallId,
					() => ({
						id: action.toolCallId,
						type: "tool",
						toolName: action.toolName,
						result: action.result,
						status: "complete",
						isError: action.isError,
					}),
					(current) => ({
						...current,
						toolName: action.toolName,
						result: action.result,
						status: "complete",
						isError: action.isError,
					}),
				),
			}));
		case "assistant_turn_end":
			return endTurn(
				state,
				action.stopReason,
				action.errorMessage,
				action.timestampMs ?? context.now(),
				action.completion,
			);
	}
}

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
