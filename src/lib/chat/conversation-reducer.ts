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
	ConversationReducerContext,
	ConversationState,
} from "./conversation-types.ts";
import type { TokenUsage } from "../api/token-usage.ts";

import { i18n } from "../../i18n/index.ts";

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
	context: ConversationReducerContext,
	stopReason: string | null | undefined,
	errorMessage: string | null | undefined,
	timestampMs: number,
	completion: "complete" | "interrupted" | "continued" = "complete",
	usage: TokenUsage | null | undefined = undefined,
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
					? i18n.t("chat.responseError")
					: completion === "interrupted"
						? i18n.t("chat.historyReplyInterrupted")
						: undefined);
	const messages = [...state.messages];
	messages[index] = {
		...current,
		text: assistantText(current.content) || current.text,
		time: context.formatTime(timestampMs),
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
		// 同一轮可能有多个 segment；保留已有用量，只有新上报才覆盖。
		usage: usage ?? current.usage,
	};
	return { ...state, messages, active: null };
}

export function isAssistantBatchAction(action: ConversationAction) {
	return (
		action.type === "assistant_message_start" ||
		action.type === "assistant_text_delta" ||
		action.type === "assistant_text_snapshot" ||
		action.type === "assistant_usage_update" ||
		action.type === "assistant_thinking_start" ||
		action.type === "assistant_thinking_delta" ||
		action.type === "assistant_thinking_end" ||
		action.type === "tool_execution_start" ||
		action.type === "tool_execution_update" ||
		action.type === "tool_execution_end" ||
		action.type === "assistant_turn_end"
	);
}

export function reduceConversation(
	state: ConversationState,
	action: ConversationAction,
	context: ConversationReducerContext,
): ConversationState {
	// A late end from the aborted turn must not finish the new placeholder.
	if (
		action.type === "assistant_turn_end" &&
		state.active?.runtimeStarted === false
	) {
		return state;
	}
	const pending = state.pendingUsers[0];
	if (pending?.previousTurn && isAssistantBatchAction(action)) {
		const index = state.messages.findIndex(
			(message) => message.id === pending.previousTurn?.assistantMessageId,
		);
		const previous = state.messages[index];
		if (previous?.role === "assistant") {
			// Until the user echo, runtime output still belongs to the previous turn.
			const next = reduceConversationAction(
				{ ...state, active: pending.previousTurn },
				action,
				context,
			);
			const updated = next.messages[index];
			let messages = next.messages;
			if (
				previous.streaming !== true &&
				updated?.role === "assistant" &&
				updated.streaming === true
			) {
				messages = messages.slice();
				messages[index] = { ...updated, streaming: false };
			}
			return { ...next, messages, active: state.active };
		}
	}
	return reduceConversationAction(state, action, context);
}

function reduceConversationAction(
	state: ConversationState,
	action: ConversationAction,
	context: ConversationReducerContext,
): ConversationState {
	switch (action.type) {
		case "local_user_submit": {
			const previous = state.messages[state.messages.length - 1];
			// Image-only prompts do not emit a text user echo in the runtime adapter.
			const previousTurn =
				action.text.length > 0 && previous?.role === "assistant"
					? {
							turnStartedAtMs: previous.timestampMs,
							firstRuntimeUserSeen: true,
							...state.active,
							assistantMessageId: previous.id,
						}
					: undefined;
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
					runtimeStarted: false,
				},
				pendingUsers: [
					...state.pendingUsers,
					{
						clientMessageId: action.clientMessageId,
						text: action.text,
						images: action.images,
						timestampMs: action.timestampMs,
						replyStartIndex:
							state.messages.length + (action.appendMessage === false ? 0 : 1),
						previousTurn,
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
			return endTurn(state, context, "aborted", null, action.timestampMs);
		case "conversation_runtime_error":
			return endTurn(
				state,
				context,
				"error",
				action.message,
				action.timestampMs,
			);
		case "compaction_marker": {
			const timestampMs = action.timestampMs ?? context.now();
			const next = state.active?.assistantMessageId
				? endTurn(
						state,
						context,
						undefined,
						undefined,
						timestampMs,
						"continued",
					)
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
							context,
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
					const startedAtMs = action.timestampMs ?? context.now();
					if (pending.replyStartIndex !== undefined) {
						const replyStartIndex = pending.replyStartIndex;
						const provisional = next.messages.slice(replyStartIndex);
						const staleAssistant = provisional.find(
							(message) =>
								message.role === "assistant" &&
								(message.text.length > 0 ||
									Boolean(message.content?.length) ||
									Boolean(message.activity?.length) ||
									message.streaming !== true),
						);
						if (
							staleAssistant?.role === "assistant" &&
							!provisional.some((message) => message.role === "user")
						) {
							// Without a previous reply to update, keep the output as its own segment.
							next = endTurn(
								next,
								context,
								staleAssistant.stopReason,
								staleAssistant.errorMessage,
								startedAtMs,
								staleAssistant.completion ?? "continued",
							);
							const userIndex = next.messages.findIndex(
								(message) => message.id === pending.clientMessageId,
							);
							const insertionIndex =
								userIndex >= 0 ? userIndex : Math.max(0, replyStartIndex - 1);
							next = {
								...next,
								messages: [
									...next.messages.slice(0, insertionIndex),
									...next.messages
										.slice(replyStartIndex)
										.filter((message) => message.role === "assistant"),
									...next.messages.slice(insertionIndex, replyStartIndex),
									...provisional.filter(
										(message) => message.role !== "assistant",
									),
								],
								active: null,
							};
							next = withAssistant(next, context, startedAtMs, (message) => ({
								...message,
								replyRunwayPx: staleAssistant.replyRunwayPx,
							}));
						}
					}
					next = {
						...next,
						active: {
							...next.active,
							turnStartedAtMs: startedAtMs,
							firstRuntimeUserSeen: true,
							runtimeStarted: true,
						},
					};
				}
				return { ...next, pendingUsers: next.pendingUsers.slice(1) };
			}
			const timestampMs = action.timestampMs ?? context.now();
			let next = state;
			if (state.active?.assistantMessageId) {
				next = endTurn(
					state,
					context,
					undefined,
					undefined,
					timestampMs,
					"continued",
				);
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
		case "assistant_message_start": {
			const next = withAssistant(
				state,
				context,
				action.timestampMs,
				(message) => message,
			);
			return {
				...next,
				active: next.active && { ...next.active, runtimeStarted: true },
			};
		}
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
		case "assistant_usage_update":
			if (!state.active?.assistantMessageId) return state;
			return withAssistant(state, context, action.timestampMs, (message) => ({
				...message,
				usage: action.usage,
			}));
		case "assistant_thinking_start":
			return withAssistant(state, context, action.timestampMs, (message) => ({
				...message,
				content: startAssistantThinkingContent(
					message.content,
					() =>
						action.sourceEntryId
							? `${action.sourceEntryId}:content:${action.sourceContentIndex ?? 0}`
							: context.createContentId("thinking"),
					action.timestampMs,
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
					action.timestampMs,
				),
				streaming: true,
			}));
		case "assistant_thinking_end":
			return withAssistant(state, context, action.timestampMs, (message) => ({
				...message,
				content: finishAssistantThinkingContent(
					message.content,
					action.timestampMs,
				),
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
				context,
				action.stopReason,
				action.errorMessage,
				action.timestampMs ?? context.now(),
				action.completion,
				action.usage,
			);
	}
}
