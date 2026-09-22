import { useCallback, useEffect, useRef, useState } from "react";

import { i18n } from "../../i18n/index.ts";
import type {
	ActiveTurn,
	ChatRuntimeRecoveryState,
	ChatSessionClient,
} from "@/components/chat/chat-runtime-types";
import type { ChatSession } from "@/components/chat/chat-page-utils";
import { isPresentationBatchedAction } from "@/components/chat/use-runtime-conversation-dispatch";
import { toAppError } from "@/lib/app-error";
import { recordChatRuntimeEvent } from "@/lib/chat-performance";
import { recordChatRuntimeTraceEvent } from "@/lib/chat-runtime-trace";
import { toConversationAction } from "@/lib/conversation-runtime-adapter";
import type { ConversationAction } from "@/lib/conversation-types";
import { notifyAgentResult } from "@/lib/desktop-notifications";
import { runtimeErrorMessage, type PiloRuntimeEvent } from "@/lib/pi-runtime";

const CONTEXT_STATS_REFRESH_DELAY_MS = 1000;

/**
 * Pi 在没有 Pilo 发起的 turn 时仍可能自主输出：Extension 接管压缩后自动继续、
 * Extension 主动发消息、自动重试后的继续等。这些输出同样属于当前对话。
 */
function isAutonomousTurnEvent(event: PiloRuntimeEvent) {
	switch (event.type) {
		case "user_message_start":
		case "assistant_message_start":
		case "assistant_text_delta":
		case "assistant_text_snapshot":
		case "assistant_thinking_start":
		case "assistant_thinking_delta":
		case "assistant_thinking_end":
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
		case "assistant_message_end":
		case "compaction_end":
			return true;
		default:
			return false;
	}
}

export function dispatchRuntimeEventToConversation(
	event: PiloRuntimeEvent,
	targetSessionId: string,
	dispatchConversation: (
		targetSessionId: string,
		action: ConversationAction,
	) => void,
	queueRuntimeAction: (
		targetSessionId: string,
		action: ConversationAction,
	) => void,
	recordMetric = true,
) {
	if (recordMetric) recordChatRuntimeEvent();
	const action = toConversationAction(event);
	if (!action) return;
	if (isPresentationBatchedAction(action)) {
		queueRuntimeAction(targetSessionId, action);
		return;
	}
	dispatchConversation(targetSessionId, action);
}

type UseChatRuntimeEventsOptions = {
	session: ChatSession;
	client: ChatSessionClient;
	activeTurnRef: { current: ActiveTurn | null };
	activeTurnSessionIdRef?: { current: string | null };
	identifiedRef: { current: ((sessionId: string) => void) | undefined };
	setActiveTurnSessionId: (sessionId: string | null) => void;
	desktopNotifications: boolean;
	dispatchConversation: (
		targetSessionId: string,
		action: ConversationAction,
	) => void;
	queueRuntimeAction: (
		targetSessionId: string,
		action: ConversationAction,
	) => void;
	setPendingQueueCounts: (steering: number, followUps: number) => void;
	setPendingSteeringCount: (count: number) => void;
	acknowledgeQueuedMessage: (turn: ActiveTurn, text: string) => void;
	releaseActiveTurn: (
		turn: ActiveTurn,
		options?: { preserveQueued?: boolean },
	) => void;
	refreshSessionState: () => Promise<void>;
	refreshSessionStats: () => Promise<void>;
};

export function useChatRuntimeEvents({
	session,
	client,
	activeTurnRef,
	activeTurnSessionIdRef,
	identifiedRef,
	setActiveTurnSessionId,
	desktopNotifications,
	dispatchConversation,
	queueRuntimeAction,
	setPendingQueueCounts,
	setPendingSteeringCount,
	acknowledgeQueuedMessage,
	releaseActiveTurn,
	refreshSessionState,
	refreshSessionStats,
}: UseChatRuntimeEventsOptions) {
	const runtimeListenerRef = useRef<ReturnType<typeof client.listen> | null>(
		null,
	);
	const runtimeEventHandlerRef = useRef<(event: PiloRuntimeEvent) => void>(
		() => {},
	);
	const [recoveryState, setRecoveryState] = useState<ChatRuntimeRecoveryState>({
		status: "idle",
		recoverable: !session.temporary,
		messageKey: "",
	});
	const recoveryPromiseRef = useRef<Promise<boolean> | null>(null);
	const contextStatsRefreshTimerRef = useRef<number | null>(null);

	const cancelContextStatsRefresh = useCallback(() => {
		if (contextStatsRefreshTimerRef.current === null) return;
		window.clearTimeout(contextStatsRefreshTimerRef.current);
		contextStatsRefreshTimerRef.current = null;
	}, []);

	const scheduleContextStatsRefresh = useCallback(() => {
		cancelContextStatsRefresh();
		contextStatsRefreshTimerRef.current = window.setTimeout(() => {
			contextStatsRefreshTimerRef.current = null;
			void refreshSessionStats().catch(() => undefined);
		}, CONTEXT_STATS_REFRESH_DELAY_MS);
	}, [cancelContextStatsRefresh, refreshSessionStats]);

	useEffect(() => cancelContextStatsRefresh, [cancelContextStatsRefresh]);

	// 自动命名 / 会话识别会在 turn 进行中更新标题，而通知在 turn 结束时才
	// 发出，同步 turn 的标题快照，避免通知仍显示「新会话」。
	useEffect(() => {
		const turn = activeTurnRef.current;
		if (turn && turn.sessionTitle !== session.title) {
			turn.sessionTitle = session.title;
		}
	}, [activeTurnRef, session.title]);

	const clearRecoveryState = useCallback(() => {
		setRecoveryState({
			status: "idle",
			recoverable: !session.temporary,
			messageKey: "",
		});
	}, [session.temporary]);

	const failActiveTurn = useCallback(
		(turn: ActiveTurn, message: string) => {
			if (activeTurnRef.current !== turn) return;
			dispatchConversation(turn.sessionId, {
				type: "conversation_runtime_error",
				message,
				timestampMs: Date.now(),
			});
			if (desktopNotifications) {
				void notifyAgentResult({
					status: "error",
					projectId: turn.projectId,
					sessionId: turn.notificationSessionId,
					sessionTitle: turn.sessionTitle,
					errorMessage: message,
				});
			}
			releaseActiveTurn(turn);
		},
		[
			activeTurnRef,
			desktopNotifications,
			dispatchConversation,
			releaseActiveTurn,
		],
	);

	const recoverRuntime = useCallback(async () => {
		if (session.temporary) {
			setRecoveryState({
				status: "failed",
				recoverable: false,
				messageKey: "chat.temporaryNotRecoverable",
			});
			return false;
		}
		if (recoveryPromiseRef.current) return recoveryPromiseRef.current;

		const recovery = (async () => {
			setRecoveryState({
				status: "reconnecting",
				recoverable: true,
				messageKey: "chat.reconnecting",
			});
			try {
				const runtimeState = await client.state();
				const resumePath = runtimeState?.sessionPath ?? session.sessionPath;
				if (!resumePath) {
					throw new Error(i18n.t("errors.sessionNotPersisted"));
				}

				const snapshot = await client.ensure();
				if (snapshot.state !== "running") {
					throw new Error(
						i18n.t("errors.runtimeRecoveryState", { state: snapshot.state }),
					);
				}
				const agentState = await client.getPiAgentState();
				if (!agentState.sessionFile) {
					throw new Error(i18n.t("errors.runtimeResumePathMissing"));
				}
				if (agentState.sessionId) identifiedRef.current?.(agentState.sessionId);
				await refreshSessionState();
				setRecoveryState({
					status: "recovered",
					recoverable: true,
					messageKey: "chat.reconnected",
				});
				return true;
			} catch (error) {
				const appError = toAppError(error);
				setRecoveryState({
					status: "failed",
					recoverable: appError.retryable,
					messageKey: "",
					error: appError,
				});
				return false;
			}
		})();
		recoveryPromiseRef.current = recovery;
		try {
			return await recovery;
		} finally {
			if (recoveryPromiseRef.current === recovery) {
				recoveryPromiseRef.current = null;
			}
		}
	}, [
		client,
		identifiedRef,
		refreshSessionState,
		session.sessionPath,
		session.temporary,
	]);

	useEffect(() => {
		if (recoveryState.status !== "recovered") return;
		const timer = window.setTimeout(() => {
			setRecoveryState((current) =>
				current.status === "recovered"
					? { status: "idle", recoverable: true, messageKey: "" }
					: current,
			);
		}, 5000);
		return () => window.clearTimeout(timer);
	}, [recoveryState.status]);

	const handleRuntimeEvent = useCallback(
		(event: PiloRuntimeEvent) => {
			recordChatRuntimeEvent();
			if (event.type === "assistant_message_start") {
				// 连续工具循环很快进入下一次模型请求时，取消上一轮尚未执行的
				// stats 刷新，等最新一次请求结束后再取一次即可。
				cancelContextStatsRefresh();
			} else if (event.type === "assistant_text_snapshot") {
				// message_end 后允许约 1 秒延迟；连续请求会自然合并为最后一次刷新。
				scheduleContextStatsRefresh();
			} else if (event.type === "assistant_message_end") {
				// agent_settled 是最终一致性点：不再等待 debounce，直接刷新完整状态。
				cancelContextStatsRefresh();
				void refreshSessionState().catch(() => undefined);
			}
			if (
				event.type === "process_state" &&
				(event.state === "failed" || event.state === "stopped")
			) {
				const interruptedTurn = activeTurnRef.current;
				const interruptedActiveTurn =
					interruptedTurn?.generation !== null &&
					interruptedTurn?.generation === event.generation;
				if (interruptedTurn && interruptedActiveTurn) {
					failActiveTurn(
						interruptedTurn,
						event.state === "failed"
							? i18n.t("chat.piProcessFailed")
							: i18n.t("chat.piProcessStopped"),
					);
				}
				if (event.state === "stopped" && !interruptedActiveTurn) return;
				if (session.temporary) {
					setRecoveryState({
						status: "failed",
						recoverable: false,
						messageKey: "chat.temporaryNotRecoverable",
					});
				} else {
					void recoverRuntime();
				}
				return;
			}

			const turn = activeTurnRef.current;
			if (!turn || turn.generation === null) {
				// Only a missing turn is autonomous output: extension-driven compaction
				// continuation, extension-initiated messages, auto-retry continuation.
				// A generation mismatch is a stale event from an earlier process and must
				// stay dropped, otherwise it lands in the current assistant message.
				if (isAutonomousTurnEvent(event)) {
					dispatchRuntimeEventToConversation(
						event,
						session.id,
						dispatchConversation,
						queueRuntimeAction,
						false,
					);
				}
				return;
			}
			if (event.generation !== turn.generation) return;

			dispatchRuntimeEventToConversation(
				event,
				turn.sessionId,
				dispatchConversation,
				queueRuntimeAction,
				false,
			);

			switch (event.type) {
				case "assistant_message_end":
					if (event.stopReason === "error" || event.errorMessage?.trim()) {
						if (desktopNotifications) {
							void notifyAgentResult({
								status: "error",
								projectId: turn.projectId,
								sessionId: turn.notificationSessionId,
								sessionTitle: turn.sessionTitle,
								errorMessage: event.errorMessage ?? undefined,
							});
						}
						releaseActiveTurn(turn);
						break;
					}
					if (
						desktopNotifications &&
						event.stopReason !== "aborted" &&
						!event.errorMessage?.trim()
					) {
						void notifyAgentResult({
							status: "completed",
							projectId: turn.projectId,
							sessionId: turn.notificationSessionId,
							sessionTitle: turn.sessionTitle,
						});
					}
					releaseActiveTurn(turn);
					break;
				case "user_message_start":
					acknowledgeQueuedMessage(turn, event.text);
					break;
				case "assistant_text_snapshot":
					break;
				case "queue_update":
					setPendingQueueCounts(event.steering.length, event.followUp.length);
					break;
				case "runtime_error":
					failActiveTurn(turn, event.message);
					break;
				case "process_state":
					break;
				case "rpc_message":
				case "assistant_message_start":
				case "assistant_text_delta":
				case "assistant_thinking_start":
				case "assistant_thinking_delta":
				case "assistant_thinking_end":
				case "tool_execution_start":
				case "tool_execution_update":
				case "tool_execution_end":
				case "runtime_log":
					break;
			}
		},
		[
			acknowledgeQueuedMessage,
			activeTurnRef,
			cancelContextStatsRefresh,
			desktopNotifications,
			dispatchConversation,
			failActiveTurn,
			queueRuntimeAction,
			recoverRuntime,
			refreshSessionState,
			releaseActiveTurn,
			scheduleContextStatsRefresh,
			session.temporary,
			session.id,
			setPendingQueueCounts,
		],
	);

	useEffect(() => {
		runtimeEventHandlerRef.current = handleRuntimeEvent;
	}, [handleRuntimeEvent]);

	useEffect(() => {
		let disposed = false;
		const subscription = client.listen((event) => {
			if (import.meta.env.DEV) {
				recordChatRuntimeTraceEvent(session.id, event);
			}
			runtimeEventHandlerRef.current(event);
		});
		runtimeListenerRef.current = subscription;
		void subscription.catch((error) => {
			if (disposed) return;
			const turn = activeTurnRef.current;
			if (turn) failActiveTurn(turn, runtimeErrorMessage(error));
			if (session.temporary) {
				setRecoveryState({
					status: "failed",
					recoverable: false,
					messageKey: "chat.temporaryNotRecoverable",
				});
			} else {
				void recoverRuntime();
			}
		});

		return () => {
			disposed = true;
			if (runtimeListenerRef.current === subscription) {
				runtimeListenerRef.current = null;
			}
			void subscription.then((unlisten) => unlisten()).catch(() => undefined);
		};
	}, [
		activeTurnRef,
		client,
		failActiveTurn,
		recoverRuntime,
		session.id,
		session.temporary,
	]);

	useEffect(() => {
		let cancelled = false;
		const recover = async () => {
			try {
				const subscription = runtimeListenerRef.current;
				if (!subscription) return;
				await subscription;
				const runtimeState = await client.state();
				if (
					cancelled ||
					!runtimeState ||
					!runtimeState.initialized ||
					runtimeState.snapshot.state !== "running" ||
					activeTurnRef.current
				) {
					return;
				}
				const agentState = await client.getPiAgentState();
				if (cancelled || !agentState.isStreaming || activeTurnRef.current)
					return;
				const turn: ActiveTurn = {
					sessionId: session.id,
					sessionTitle: session.title,
					projectId: session.projectRecord.id,
					notificationSessionId: session.temporary
						? session.id
						: (agentState.sessionId ?? session.id),
					generation: runtimeState.snapshot.generation,
					promptSent: true,
					queueReady: true,
					preserveQueuedOnRelease: false,
				};
				activeTurnRef.current = turn;
				if (activeTurnSessionIdRef) {
					activeTurnSessionIdRef.current = turn.sessionId;
				}
				setActiveTurnSessionId(turn.sessionId);
				setPendingSteeringCount(agentState.pendingMessageCount ?? 0);
				if (!session.temporary) {
					identifiedRef.current?.(agentState.sessionId ?? session.id);
				}
				setRecoveryState({
					status: "recovered",
					recoverable: true,
					messageKey: "chat.reconnectedActive",
				});
			} catch (error) {
				if (!cancelled) console.warn("Failed to recover active Pi turn", error);
			}
		};
		void recover();
		return () => {
			cancelled = true;
		};
	}, [
		activeTurnRef,
		activeTurnSessionIdRef,
		client,
		identifiedRef,
		session.id,
		session.projectRecord.id,
		session.temporary,
		session.title,
		setActiveTurnSessionId,
		setPendingSteeringCount,
	]);

	return {
		runtimeListenerRef,
		recoveryState,
		recoverRuntime,
		clearRecoveryState,
		failActiveTurn,
	};
}
