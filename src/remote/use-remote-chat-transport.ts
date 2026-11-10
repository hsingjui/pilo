import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useCallback,
	useRef,
} from "react";

import { markExternalTurnLive } from "@/components/chat/chat-conversation-model";
import { i18n } from "@/i18n";
import type { ChatSubmission } from "@/lib/chat/chat-submission";
import { chatRpcChangesActivity } from "@/lib/chat/chat-session-runtime-model";
import {
	coalesceConversationActions,
	reduceConversationActions,
} from "@/lib/chat/conversation-replay";
import type {
	ConversationAction,
	ConversationState,
} from "@/lib/chat/conversation-types";
import { toConversationAction } from "@/lib/chat/conversation-runtime-adapter";
import type { PiloClientEventMessage } from "@/lib/api/pilo-client";
import { runtimeErrorMessage } from "@/lib/api/pi-runtime";
import type { PiloRuntimeEvent } from "@/lib/api/pi-runtime";
import type { PiExtensionDialogRequest } from "@/components/chat/use-pi-session-features";
import { REMOTE_SEQUENCE_KEY } from "./remote-client";
import {
	isRpcResponse,
	reducerContext,
	type RetryState,
} from "./remote-app-model";
import type { WebPiloClient } from "./web-pilo-client";

type PendingRpc = {
	sessionKey: string;
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
	timer: number;
};

export type QueuedSubmission = {
	submission: ChatSubmission;
	queueKind: "steer" | "follow_up";
};

export type RemoteRpc = <T>(
	command: Record<string, unknown>,
	timeoutMs?: number,
) => Promise<T>;

export type RemoteSessionRpc = <T>(
	targetSessionKey: string,
	command: Record<string, unknown>,
	timeoutMs?: number,
) => Promise<T>;

type UseRemoteChatTransportOptions = {
	client: WebPiloClient | null;
	handleModelScopeEvent: (event: PiloRuntimeEvent) => void;
	handleExpiredAuth: (error: unknown) => boolean;
	setFatalError: (message: string | null) => void;
	setResyncKey: Dispatch<SetStateAction<number>>;
	setConversation: Dispatch<SetStateAction<ConversationState>>;
	scheduleRuntimeActivityRefresh: (projectId?: string) => void;
	refreshAllSessions: () => Promise<void>;
	refreshAgentConfigRef: MutableRefObject<(() => Promise<void>) | null>;
	handleExtensionRequestRef: MutableRefObject<
		((event: PiExtensionDialogRequest) => void) | null
	>;
	activeSessionKeyRef: MutableRefObject<string | null>;
	projectMcpApprovalRequestedRef: MutableRefObject<Set<string>>;
	queuedSubmissionsRef: MutableRefObject<Map<string, QueuedSubmission>>;
	setCompacting: Dispatch<SetStateAction<boolean>>;
	setRetryState: Dispatch<SetStateAction<RetryState | null>>;
};

export function useRemoteChatTransport({
	client,
	handleModelScopeEvent,
	handleExpiredAuth,
	setFatalError,
	setResyncKey,
	setConversation,
	scheduleRuntimeActivityRefresh,
	refreshAllSessions,
	refreshAgentConfigRef,
	handleExtensionRequestRef,
	activeSessionKeyRef,
	projectMcpApprovalRequestedRef,
	queuedSubmissionsRef,
	setCompacting,
	setRetryState,
}: UseRemoteChatTransportOptions) {
	const rpcSequenceRef = useRef(0);
	const pendingRpcRef = useRef(new Map<string, PendingRpc>());
	const lastSequenceRef = useRef(0);
	const lastSocketMessageAtRef = useRef<number | null>(null);

	const handleSocketMessage = useCallback(
		(message: PiloClientEventMessage) => {
			lastSocketMessageAtRef.current = Date.now();
			if (
				message.type === "resyncRequired" ||
				(message.type === "hello" &&
					message.latestSequence < lastSequenceRef.current)
			) {
				lastSequenceRef.current = message.latestSequence;
				window.localStorage.setItem(
					REMOTE_SEQUENCE_KEY,
					String(message.latestSequence),
				);
				if (message.type === "resyncRequired") {
					setResyncKey((value) => value + 1);
				}
				return;
			}
			if (message.type !== "events") return;
			let lastSequence = lastSequenceRef.current;
			const actions: ConversationAction[] = [];
			for (const event of message.events) {
				// Foreground recovery can overlap a queued frame with socket replay.
				if (event.sequence <= lastSequence) continue;
				lastSequence = event.sequence;
				if (event.type === "project_model_scope_changed") {
					handleModelScopeEvent(event);
					continue;
				}
				if (
					event.type === "sessions_indexed" ||
					event.type === "session_index_error" ||
					event.type === "theme_settings_changed" ||
					event.type === "session_read_state_changed" ||
					event.type === "session_turn_completed"
				)
					continue;
				if (event.type === "rpc_message" && isRpcResponse(event.message)) {
					const id = event.message.id;
					if (id) {
						const pending = pendingRpcRef.current.get(id);
						if (pending) {
							window.clearTimeout(pending.timer);
							pendingRpcRef.current.delete(id);
							if (event.message.success) pending.resolve(event.message.data);
							else
								pending.reject(
									new Error(event.message.error || "Pi command failed"),
								);
						}
					}
				}
				// Running/unread markers track every session, not just the visible one.
				switch (event.type) {
					case "user_message_start":
					case "assistant_message_end":
					case "compaction_end":
					case "process_state":
						scheduleRuntimeActivityRefresh(event.projectId);
						break;
					case "assistant_message_start":
					case "auto_retry_start":
					case "compaction_start":
					case "runtime_error":
						scheduleRuntimeActivityRefresh();
						break;
					case "rpc_message":
						if (
							chatRpcChangesActivity(event.message) ||
							(isRpcResponse(event.message) &&
								event.message.command === "set_session_name")
						) {
							scheduleRuntimeActivityRefresh(event.projectId);
						}
						break;
				}
				if (
					event.type === "runtime_error" ||
					(event.type === "process_state" &&
						(event.state === "stopped" || event.state === "failed"))
				) {
					const error = new Error(
						event.type === "runtime_error"
							? event.message
							: i18n.t(
									event.state === "failed"
										? "chat.piProcessFailed"
										: "chat.piProcessStopped",
								),
					);
					for (const [id, pending] of pendingRpcRef.current) {
						if (pending.sessionKey !== event.sessionKey) continue;
						window.clearTimeout(pending.timer);
						pendingRpcRef.current.delete(id);
						pending.reject(error);
					}
					if (
						event.sessionKey &&
						projectMcpApprovalRequestedRef.current.has(event.sessionKey)
					) {
						continue;
					}
				}
				if (event.sessionKey !== activeSessionKeyRef.current) continue;
				if (event.type === "extension_ui_request") {
					handleExtensionRequestRef.current?.(event);
				}
				switch (event.type) {
					case "runtime_error":
						setCompacting(false);
						setRetryState(null);
						setFatalError(event.message);
						actions.push({
							type: "conversation_runtime_error",
							message: event.message,
							timestampMs: event.timestampMs,
						});
						break;
					case "process_state":
						if (event.state === "stopped" || event.state === "failed") {
							setCompacting(false);
							setRetryState(null);
							actions.push({
								type: "local_turn_abort",
								timestampMs: event.timestampMs,
							});
						}
						break;
					case "compaction_start":
						setCompacting(true);
						break;
					case "compaction_end":
						setCompacting(false);
						break;
					case "auto_retry_start":
						setRetryState({
							kind: "agent",
							attempt: event.attempt,
							maxAttempts: event.maxAttempts,
							delayMs: event.delayMs,
							errorMessage: event.errorMessage,
						});
						break;
					case "auto_retry_end":
						setRetryState(null);
						break;
					case "summarization_retry_scheduled":
						setRetryState({
							kind: "summary",
							attempt: event.attempt,
							maxAttempts: event.maxAttempts,
							delayMs: event.delayMs,
							errorMessage: event.errorMessage,
						});
						break;
					case "summarization_retry_finished":
						setRetryState(null);
						break;
				}
				const action = toConversationAction(event as PiloRuntimeEvent);
				if (action) actions.push(action);
				if (event.type === "assistant_message_end") {
					window.setTimeout(() => {
						void refreshAllSessions();
						void refreshAgentConfigRef.current?.();
					}, 500);
				}
			}
			if (lastSequence > lastSequenceRef.current) {
				lastSequenceRef.current = lastSequence;
				window.localStorage.setItem(REMOTE_SEQUENCE_KEY, String(lastSequence));
			}
			if (actions.length > 0) {
				setConversation((current) => {
					let next = current;
					let batch: ConversationAction[] = [];
					const flush = () => {
						if (batch.length === 0) return;
						next = reduceConversationActions(
							next,
							coalesceConversationActions(batch),
							reducerContext,
						);
						batch = [];
					};
					for (const action of actions) {
						// Live events can arrive before the bootstrap reports the open turn.
						switch (action.type) {
							case "assistant_message_start":
							case "assistant_text_delta":
							case "assistant_text_snapshot":
							case "assistant_thinking_start":
							case "assistant_thinking_delta":
							case "assistant_thinking_end":
							case "tool_execution_start":
							case "tool_execution_update":
							case "tool_execution_end":
							case "assistant_turn_end":
								if (!next.active) {
									flush();
									next = markExternalTurnLive(next);
								}
								break;
							default:
								flush();
								break;
						}
						if (action.type === "user_message_start") {
							const pending = next.pendingUsers[0];
							if (pending?.queueKind) {
								queuedSubmissionsRef.current.delete(pending.clientMessageId);
							}
						}
						batch.push(action);
						if (action.type === "assistant_turn_end") flush();
					}
					flush();
					return next;
				});
			}
		},
		[
			activeSessionKeyRef,
			projectMcpApprovalRequestedRef,
			queuedSubmissionsRef,
			handleExtensionRequestRef,
			handleModelScopeEvent,
			refreshAgentConfigRef,
			refreshAllSessions,
			scheduleRuntimeActivityRefresh,
			setCompacting,
			setConversation,
			setFatalError,
			setResyncKey,
			setRetryState,
		],
	);

	const rpcForSession = useCallback(
		async <T>(
			targetSessionKey: string,
			command: Record<string, unknown>,
			timeoutMs = 10_000,
		): Promise<T> => {
			if (!client) throw new Error("Chat is not ready");
			rpcSequenceRef.current += 1;
			const id = "remote-" + Date.now() + "-" + String(rpcSequenceRef.current);
			const startedAt = Date.now();
			let sendCompleted = false;
			const response = new Promise<T>((resolve, reject) => {
				const timer = window.setTimeout(() => {
					console.warn(
						"Remote Pi RPC timeout",
						JSON.stringify({
							id,
							command:
								typeof command.type === "string" ? command.type : "unknown",
							sessionKey: targetSessionKey,
							timeoutMs,
							elapsedMs: Date.now() - startedAt,
							sendCompleted,
							pendingRequests: pendingRpcRef.current.size,
							lastSequence: lastSequenceRef.current,
							lastSocketMessageAgeMs:
								lastSocketMessageAtRef.current === null
									? null
									: Date.now() - lastSocketMessageAtRef.current,
						}),
					);
					pendingRpcRef.current.delete(id);
					reject(new Error("Pi command timed out"));
				}, timeoutMs);
				pendingRpcRef.current.set(id, {
					sessionKey: targetSessionKey,
					resolve: (value) => resolve(value as T),
					reject,
					timer,
				});
			});
			try {
				const [, result] = await Promise.all([
					client
						.sendChatCommand(targetSessionKey, { ...command, id })
						.then(() => {
							sendCompleted = true;
						}),
					response,
				]);
				return result;
			} catch (error) {
				const pending = pendingRpcRef.current.get(id);
				if (pending) {
					window.clearTimeout(pending.timer);
					pendingRpcRef.current.delete(id);
					pending.reject(error);
				}
				throw error;
			}
		},
		[client],
	);

	const rpc = useCallback(
		<T>(command: Record<string, unknown>, timeoutMs = 10_000) => {
			const targetSessionKey = activeSessionKeyRef.current;
			if (!targetSessionKey) throw new Error("Chat is not ready");
			return rpcForSession<T>(targetSessionKey, command, timeoutMs);
		},
		[rpcForSession, activeSessionKeyRef],
	);

	// 与桌面端 chat-page.tsx 的 abortPiRetry 对齐；abort_retry 已在 Remote 命令白名单内。
	const abortPiRetry = useCallback(
		() =>
			rpc<void>({ type: "abort_retry" })
				.then(() => setRetryState(null))
				.catch((error: unknown) => {
					if (!handleExpiredAuth(error))
						setFatalError(runtimeErrorMessage(error));
				}),
		[rpc, handleExpiredAuth, setFatalError, setRetryState],
	);

	return { handleSocketMessage, rpcForSession, rpc, abortPiRetry };
}
