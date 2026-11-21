import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
} from "react";

import { markExternalTurnLive } from "@/components/chat/chat-conversation-model";
import { isPresentationBatchedAction } from "@/components/chat/use-runtime-conversation-dispatch";
import { i18n } from "@/i18n";
import type { ChatSubmission } from "@shared/chat/chat-submission";
import { chatRpcChangesActivity } from "@shared/chat/chat-session-runtime-model";
import {
	getActiveStreamingPresentationChars,
	getStreamingPresentationIntervalMs,
} from "@/lib/chat/chat-stream-presentation";
import {
	coalesceConversationActions,
	pushCoalescedConversationAction,
	reduceConversationActions,
} from "@shared/chat/conversation-replay";
import type {
	ConversationAction,
	ConversationState,
} from "@shared/chat/conversation-types";
import { toConversationAction } from "@shared/chat/conversation-runtime-adapter";
import type { PiloClientEventMessage } from "@shared/api/pilo-client";
import { runtimeErrorMessage } from "@/lib/api/pi-runtime";
import type { PiloRuntimeEvent } from "@/lib/api/pi-runtime";
import type { PiExtensionDialogRequest } from "@/components/chat/pi-extension-dialog-request";
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

/** Unacknowledged user input of a session the user left; `null` marks a prompt. */
export type ParkedQueuedSubmission = {
	clientMessageId: string;
	submission: ChatSubmission | null;
};

const STREAM_STALLED_PREFIX = "PILO_STREAM_STALLED:";
// Replay dedupe uses the in-memory sequence; storage only seeds a new page.
const SEQUENCE_PERSIST_INTERVAL_MS = 1_000;

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
	lastSequenceRef: MutableRefObject<number>;
	handleModelScopeEvent: (event: PiloRuntimeEvent) => void;
	handleExpiredAuth: (error: unknown) => boolean;
	setFatalError: (message: string | null) => void;
	setResyncKey: Dispatch<SetStateAction<number>>;
	onSessionCompleted: (projectId: string, sessionPath: string) => void;
	setConversation: Dispatch<SetStateAction<ConversationState>>;
	/** Reads the store without flushing buffered streaming output. */
	getConversationState: () => ConversationState;
	scheduleRuntimeActivityRefresh: (projectId?: string) => void;
	refreshAllSessions: () => Promise<void>;
	refreshAgentConfigRef: MutableRefObject<(() => Promise<void>) | null>;
	handleExtensionRequestRef: MutableRefObject<
		((event: PiExtensionDialogRequest) => void) | null
	>;
	activeSessionKeyRef: MutableRefObject<string | null>;
	projectMcpApprovalRequestedRef: MutableRefObject<Set<string>>;
	queuedSubmissionsRef: MutableRefObject<Map<string, QueuedSubmission>>;
	parkedQueuedSubmissionsRef: MutableRefObject<
		Map<string, ParkedQueuedSubmission[]>
	>;
	recoverSubmissionsRef: MutableRefObject<
		| ((sessionKey: string, submissions: readonly ChatSubmission[]) => void)
		| null
	>;
	setCompacting: Dispatch<SetStateAction<boolean>>;
	setRetryState: Dispatch<SetStateAction<RetryState | null>>;
};

export function useRemoteChatTransport({
	client,
	lastSequenceRef,
	handleModelScopeEvent,
	handleExpiredAuth,
	setFatalError,
	setResyncKey,
	onSessionCompleted,
	setConversation,
	getConversationState,
	scheduleRuntimeActivityRefresh,
	refreshAllSessions,
	refreshAgentConfigRef,
	handleExtensionRequestRef,
	activeSessionKeyRef,
	projectMcpApprovalRequestedRef,
	queuedSubmissionsRef,
	parkedQueuedSubmissionsRef,
	recoverSubmissionsRef,
	setCompacting,
	setRetryState,
}: UseRemoteChatTransportOptions) {
	const rpcSequenceRef = useRef(0);
	const pendingRpcRef = useRef(new Map<string, PendingRpc>());
	const lastSocketMessageAtRef = useRef<number | null>(null);
	const deferredActionsRef = useRef<{
		sessionKey: string;
		actions: ConversationAction[];
	} | null>(null);
	const deferredFlushTimerRef = useRef<number | null>(null);
	const lastPresentationAtRef = useRef(0);
	const sequencePersistTimerRef = useRef<number | null>(null);

	const persistSequence = useCallback(() => {
		if (sequencePersistTimerRef.current === null) return;
		window.clearTimeout(sequencePersistTimerRef.current);
		sequencePersistTimerRef.current = null;
		window.localStorage.setItem(
			REMOTE_SEQUENCE_KEY,
			String(lastSequenceRef.current),
		);
	}, [lastSequenceRef]);

	const schedulePersistSequence = useCallback(() => {
		if (sequencePersistTimerRef.current !== null) return;
		sequencePersistTimerRef.current = window.setTimeout(
			persistSequence,
			SEQUENCE_PERSIST_INTERVAL_MS,
		);
	}, [persistSequence]);

	useEffect(() => {
		// Leaving or hiding the page writes the exact sequence before suspension.
		const persistWhenHidden = () => {
			if (document.visibilityState === "hidden") persistSequence();
		};
		window.addEventListener("pagehide", persistSequence);
		document.addEventListener("visibilitychange", persistWhenHidden);
		return () => {
			window.removeEventListener("pagehide", persistSequence);
			document.removeEventListener("visibilitychange", persistWhenHidden);
			persistSequence();
		};
	}, [persistSequence]);

	const applyConversationActions = useCallback(
		(sessionKey: string | null, actions: readonly ConversationAction[]) => {
			lastPresentationAtRef.current = performance.now();
			const recovered: ChatSubmission[] = [];
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
					if (action.type === "assistant_turn_end") {
						flush();
						if (!action.errorMessage?.startsWith(STREAM_STALLED_PREFIX)) {
							continue;
						}
						// Pi's queue has been cleared. Only restore submissions that
						// have not already been acknowledged by a user-message echo.
						for (const pending of next.pendingUsers) {
							if (!pending.queueKind) continue;
							const id = pending.clientMessageId;
							const queued = queuedSubmissionsRef.current.get(id);
							if (!queued) continue;
							queuedSubmissionsRef.current.delete(id);
							recovered.push(queued.submission);
							batch.push({
								type: "local_user_queue_failed",
								clientMessageId: id,
							});
						}
						flush();
					}
				}
				flush();
				return next;
			});
			if (sessionKey && recovered.length > 0) {
				recoverSubmissionsRef.current?.(sessionKey, recovered);
			}
		},
		[queuedSubmissionsRef, recoverSubmissionsRef, setConversation],
	);

	/** Removes buffered streaming output; output from another session is dropped. */
	const takeDeferredConversationActions = useCallback(
		(sessionKey: string | null) => {
			if (deferredFlushTimerRef.current !== null) {
				window.clearTimeout(deferredFlushTimerRef.current);
				deferredFlushTimerRef.current = null;
			}
			const deferred = deferredActionsRef.current;
			deferredActionsRef.current = null;
			return deferred && deferred.sessionKey === sessionKey
				? deferred.actions
				: null;
		},
		[],
	);

	const flushDeferredConversation = useCallback(() => {
		const sessionKey = activeSessionKeyRef.current;
		const deferred = takeDeferredConversationActions(sessionKey);
		if (deferred) applyConversationActions(sessionKey, deferred);
	}, [
		activeSessionKeyRef,
		applyConversationActions,
		takeDeferredConversationActions,
	]);

	// Server frames arrive every 16 ms while streaming. Present deltas at the
	// same adaptive cadence as the desktop chat instead of rendering every frame.
	const deferConversationActions = useCallback(
		(sessionKey: string, actions: readonly ConversationAction[]) => {
			if (deferredActionsRef.current?.sessionKey !== sessionKey) {
				takeDeferredConversationActions(null);
			}
			const deferred = (deferredActionsRef.current ??= {
				sessionKey,
				actions: [],
			});
			for (const action of actions) {
				pushCoalescedConversationAction(deferred.actions, action);
			}
			if (deferredFlushTimerRef.current !== null) return;
			const intervalMs = getStreamingPresentationIntervalMs(
				getActiveStreamingPresentationChars(getConversationState()),
			);
			const delayMs = Math.max(
				0,
				intervalMs - (performance.now() - lastPresentationAtRef.current),
			);
			deferredFlushTimerRef.current = window.setTimeout(() => {
				deferredFlushTimerRef.current = null;
				flushDeferredConversation();
			}, delayMs);
		},
		[
			flushDeferredConversation,
			getConversationState,
			takeDeferredConversationActions,
		],
	);

	useEffect(
		() => () => {
			if (deferredFlushTimerRef.current !== null) {
				window.clearTimeout(deferredFlushTimerRef.current);
			}
		},
		[],
	);

	const handleSocketMessage = useCallback(
		(message: PiloClientEventMessage) => {
			lastSocketMessageAtRef.current = Date.now();
			if (
				message.type === "resyncRequired" ||
				(message.type === "hello" &&
					message.latestSequence < lastSequenceRef.current)
			) {
				lastSequenceRef.current = message.latestSequence;
				if (sequencePersistTimerRef.current !== null) {
					window.clearTimeout(sequencePersistTimerRef.current);
					sequencePersistTimerRef.current = null;
				}
				window.localStorage.setItem(
					REMOTE_SEQUENCE_KEY,
					String(message.latestSequence),
				);
				setResyncKey((value) => value + 1);
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
				if (event.type === "session_turn_completed") {
					onSessionCompleted(event.projectId, event.sessionPath);
					scheduleRuntimeActivityRefresh(event.projectId);
					continue;
				}
				if (
					event.type === "sessions_indexed" ||
					event.type === "session_index_error" ||
					event.type === "external_session_activity_changed" ||
					event.type === "theme_settings_changed" ||
					event.type === "session_read_state_changed"
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
					case "pi_reattached":
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
				const parked = event.sessionKey
					? parkedQueuedSubmissionsRef.current.get(event.sessionKey)
					: undefined;
				if (event.sessionKey && parked) {
					// Echoes consume unacknowledged user messages in send order.
					if (event.type === "user_message_start") parked.shift();
					const settled =
						event.type === "assistant_message_end" ||
						(event.type === "process_state" &&
							(event.state === "stopped" || event.state === "failed"));
					if (settled || !parked.some((item) => item.submission)) {
						parkedQueuedSubmissionsRef.current.delete(event.sessionKey);
					}
					if (
						event.type === "assistant_message_end" &&
						event.errorMessage?.startsWith(STREAM_STALLED_PREFIX)
					) {
						// Pi cleared its queue before settling; return parked input to its session.
						const recovered = parked.flatMap((item) =>
							item.submission ? [item.submission] : [],
						);
						if (recovered.length > 0) {
							recoverSubmissionsRef.current?.(event.sessionKey, recovered);
						}
					}
				}
				if (event.sessionKey !== activeSessionKeyRef.current) continue;
				if (event.type === "extension_ui_request") {
					handleExtensionRequestRef.current?.(event);
				}
				switch (event.type) {
					case "pi_reattached":
						setCompacting(event.compacting);
						setRetryState(null);
						if (!event.active) {
							actions.push({
								type: "local_turn_abort",
								timestampMs: event.timestampMs,
							});
						}
						setResyncKey((value) => value + 1);
						break;
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
				schedulePersistSequence();
			}
			if (actions.length === 0) return;
			const sessionKey = activeSessionKeyRef.current;
			if (
				sessionKey &&
				actions.every(isPresentationBatchedAction) &&
				getConversationState().active
			) {
				deferConversationActions(sessionKey, actions);
				return;
			}
			// Anything else keeps event order by applying buffered output first.
			const deferred = takeDeferredConversationActions(sessionKey);
			applyConversationActions(
				sessionKey,
				deferred ? [...deferred, ...actions] : actions,
			);
		},
		[
			activeSessionKeyRef,
			applyConversationActions,
			deferConversationActions,
			getConversationState,
			projectMcpApprovalRequestedRef,
			parkedQueuedSubmissionsRef,
			recoverSubmissionsRef,
			handleExtensionRequestRef,
			handleModelScopeEvent,
			lastSequenceRef,
			onSessionCompleted,
			refreshAgentConfigRef,
			refreshAllSessions,
			schedulePersistSequence,
			scheduleRuntimeActivityRefresh,
			setCompacting,
			setFatalError,
			setResyncKey,
			setRetryState,
			takeDeferredConversationActions,
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
		[client, lastSequenceRef],
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

	return {
		handleSocketMessage,
		flushDeferredConversation,
		rpcForSession,
		rpc,
		abortPiRetry,
	};
}
