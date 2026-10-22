import { useCallback, useEffect, useRef, useState } from "react";

import { i18n } from "../../i18n/index.ts";
import type {
	ActiveTurn,
	ChatRuntimeRecoveryState,
	ChatSessionClient,
	DiscardedRuntimeBarrier,
} from "@/components/chat/chat-runtime-types";
import type { ChatSession } from "@/components/chat/chat-page-utils";
import { isPresentationBatchedAction } from "@/components/chat/use-runtime-conversation-dispatch";
import { recordChatRuntimeEvent } from "@/lib/chat/chat-performance";
import { recordChatRuntimeTraceEvent } from "@/lib/chat/chat-runtime-trace";
import { toConversationAction } from "@/lib/chat/conversation-runtime-adapter";
import type {
	ConversationAction,
	ConversationState,
} from "@/lib/chat/conversation-types";
import {
	notifyAgentResult,
	type AgentNotificationStatus,
} from "@/lib/desktop-notifications";
import {
	runtimeErrorMessage,
	type PiAgentState,
	type PiloRuntimeEvent,
} from "@/lib/api/pi-runtime";

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
		case "assistant_usage_update":
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
	sessionTitle: string;
	client: ChatSessionClient;
	activeTurnRef: { current: ActiveTurn | null };
	activeTurnSessionIdRef?: { current: string | null };
	runtimeGenerationRef: { current: number | null };
	discardedRuntimeBarrierRef: { current: DiscardedRuntimeBarrier | null };
	projectMcpApprovalPendingRef: { current: boolean };
	identifiedRef: { current: ((sessionId: string) => void) | undefined };
	setActiveTurnSessionId: (sessionId: string | null) => void;
	desktopNotifications: boolean;
	getConversationState: () => ConversationState | undefined;
	dispatchConversation: (
		targetSessionId: string,
		action: ConversationAction,
	) => void;
	queueRuntimeAction: (
		targetSessionId: string,
		action: ConversationAction,
	) => void;
	setPendingQueueCounts: (followUps: number) => void;
	acknowledgeQueuedMessage: (turn: ActiveTurn, clientMessageId: string) => void;
	releaseActiveTurn: (
		turn: ActiveTurn,
		options?: { preserveQueued?: boolean },
	) => void;
	refreshSessionState: (agentState?: PiAgentState) => Promise<void>;
	refreshSessionStats: () => Promise<void>;
};

export function useChatRuntimeEvents({
	session,
	sessionTitle,
	client,
	activeTurnRef,
	activeTurnSessionIdRef,
	runtimeGenerationRef,
	discardedRuntimeBarrierRef,
	projectMcpApprovalPendingRef,
	identifiedRef,
	setActiveTurnSessionId,
	desktopNotifications,
	getConversationState,
	dispatchConversation,
	queueRuntimeAction,
	setPendingQueueCounts,
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
		if (turn && turn.sessionTitle !== sessionTitle) {
			turn.sessionTitle = sessionTitle;
		}
	}, [activeTurnRef, sessionTitle]);

	const clearRecoveryState = useCallback(() => {
		setRecoveryState({
			status: "idle",
			recoverable: !session.temporary,
			messageKey: "",
		});
	}, [session.temporary]);

	const notifyTurnResult = useCallback(
		async (
			turn: ActiveTurn,
			status: AgentNotificationStatus,
			errorMessage?: string,
		) => {
			if (turn.suppressResultNotification) return;
			// 标题生成和 React 状态更新都可能晚于 turn 结束，通知不依赖渲染时序。
			let title = (await turn.sessionTitleReady) ?? turn.sessionTitle;
			if (
				turn.generation !== null &&
				runtimeGenerationRef.current === turn.generation
			) {
				const state = await client.getPiAgentState().catch(() => undefined);
				if (
					runtimeGenerationRef.current === turn.generation &&
					state?.sessionId === turn.notificationSessionId
				) {
					title = state.sessionName?.trim() || title;
				}
			}
			// 手动打断可能发生在等待标题或状态期间。
			if (turn.suppressResultNotification) return;
			await notifyAgentResult({
				status,
				projectId: turn.projectId,
				sessionId: turn.notificationSessionId,
				sessionTitle: title,
				errorMessage,
			});
		},
		[client, runtimeGenerationRef],
	);

	const failActiveTurn = useCallback(
		(turn: ActiveTurn, message: string) => {
			if (activeTurnRef.current !== turn) return;
			dispatchConversation(turn.sessionId, {
				type: "conversation_runtime_error",
				message,
				timestampMs: Date.now(),
			});
			if (desktopNotifications) {
				void notifyTurnResult(turn, "error", message);
			}
			releaseActiveTurn(turn);
		},
		[
			activeTurnRef,
			desktopNotifications,
			dispatchConversation,
			notifyTurnResult,
			releaseActiveTurn,
		],
	);

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

	const adoptActiveTurn = useCallback(
		(generation: number, notificationSessionId = session.id) => {
			const turn: ActiveTurn = {
				sessionId: session.id,
				sessionTitle,
				projectId: session.projectRecord.id,
				notificationSessionId,
				generation,
				promptSent: true,
				queueReady: true,
				preserveQueuedOnRelease: false,
			};
			activeTurnRef.current = turn;
			if (activeTurnSessionIdRef) {
				activeTurnSessionIdRef.current = turn.sessionId;
			}
			setActiveTurnSessionId(turn.sessionId);
			return turn;
		},
		[
			activeTurnRef,
			activeTurnSessionIdRef,
			session.id,
			session.projectRecord.id,
			sessionTitle,
			setActiveTurnSessionId,
		],
	);

	const handleRuntimeEvent = useCallback(
		(event: PiloRuntimeEvent) => {
			if (!("generation" in event)) return;
			recordChatRuntimeEvent();
			const latestGeneration = runtimeGenerationRef.current;
			if (latestGeneration !== null && event.generation < latestGeneration) {
				return;
			}
			if (latestGeneration === null || event.generation > latestGeneration) {
				runtimeGenerationRef.current = event.generation;
			}

			const currentTurn = activeTurnRef.current;
			const discardingCurrentTurn =
				currentTurn?.discardRuntimeEvents === true &&
				currentTurn.generation !== null &&
				currentTurn.generation === event.generation;
			if (discardingCurrentTurn) {
				cancelContextStatsRefresh();
				if (event.type === "assistant_message_end") {
					void refreshSessionState().catch(() => undefined);
					releaseActiveTurn(currentTurn, { preserveQueued: true });
				} else if (
					event.type === "process_state" &&
					(event.state === "failed" || event.state === "stopped")
				) {
					releaseActiveTurn(currentTurn, { preserveQueued: true });
				}
				// runtime_error and all intermediate events stay suppressed while the
				// stop watchdog owns this turn. They must not release ownership early.
				return;
			}

			const discardedBarrier = discardedRuntimeBarrierRef.current;
			if (
				discardedBarrier &&
				discardedBarrier.turn !== currentTurn &&
				discardedBarrier.generation === event.generation
			) {
				if (!currentTurn || !currentTurn.promptSent) return;
				discardedRuntimeBarrierRef.current = null;
			} else if (
				discardedBarrier &&
				currentTurn &&
				discardedBarrier.turn !== currentTurn &&
				currentTurn.promptSent
			) {
				discardedRuntimeBarrierRef.current = null;
			}

			if (
				currentTurn?.generation === event.generation &&
				currentTurn.runtimeStarted === false
			) {
				// A generation identifies the process, not the turn: an old settle can
				// arrive while the replacement prompt is still waiting for its start.
				if (event.type === "assistant_message_end") return;
				if (
					currentTurn.promptSent &&
					(event.type === "user_message_start" ||
						event.type === "assistant_message_start")
				) {
					currentTurn.runtimeStarted = true;
				}
			}

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
				// pi-mcp-adapter can intentionally terminate the first startup while a
				// project MCP confirmation is waiting. Treat that process exit as part of
				// the approval handshake instead of surfacing runtime recovery UI.
				if (projectMcpApprovalPendingRef.current) return;
				const interruptedTurn = activeTurnRef.current;
				const interruptedActiveTurn =
					interruptedTurn?.generation !== null &&
					interruptedTurn?.generation === event.generation;
				if (interruptedTurn && interruptedActiveTurn) {
					if (event.state === "failed") {
						failActiveTurn(interruptedTurn, i18n.t("chat.piProcessFailed"));
					} else {
						// A graceful stop is an explicit teardown (stop/detach/delete/evict),
						// not a crash: end the turn without an error and without restarting Pi.
						dispatchConversation(interruptedTurn.sessionId, {
							type: "local_turn_abort",
							timestampMs: Date.now(),
						});
						releaseActiveTurn(interruptedTurn, { preserveQueued: true });
					}
				}
				if (event.state === "stopped") return;
				// Each open controller receives server failures; recovery must be opt-in
				// so a reconnect does not restart every interrupted Pi session.
				setRecoveryState({
					status: "failed",
					recoverable: !session.temporary,
					messageKey: session.temporary
						? "chat.temporaryNotRecoverable"
						: "chat.runtimeReconnectRequired",
				});
				return;
			}

			let turn = activeTurnRef.current;
			if (
				!turn &&
				(event.type === "user_message_start" ||
					event.type === "assistant_message_start")
			) {
				// Extension-driven continuation must own a turn, not just render output.
				turn = adoptActiveTurn(event.generation);
			}
			if (!turn || turn.generation === null) {
				// Late completion/compaction events can still update the conversation
				// without creating a running turn. Generation mismatches stay dropped.
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

			// Capture the pending item consumed by this echo, not another with the same text.
			const pendingUser =
				event.type === "user_message_start"
					? getConversationState()?.pendingUsers[0]
					: undefined;
			dispatchRuntimeEventToConversation(
				event,
				turn.sessionId,
				dispatchConversation,
				queueRuntimeAction,
				false,
			);

			switch (event.type) {
				case "assistant_message_end":
					if (event.stopReason === "aborted") {
						releaseActiveTurn(turn);
						break;
					}
					if (event.stopReason === "error" || event.errorMessage?.trim()) {
						if (desktopNotifications) {
							void notifyTurnResult(
								turn,
								"error",
								event.errorMessage ?? undefined,
							);
						}
						releaseActiveTurn(turn);
						break;
					}
					if (desktopNotifications) {
						void notifyTurnResult(turn, "completed");
					}
					releaseActiveTurn(turn);
					break;
				case "user_message_start":
					if (pendingUser?.queueKind) {
						acknowledgeQueuedMessage(turn, pendingUser.clientMessageId);
					}
					break;
				case "assistant_text_snapshot":
				case "assistant_usage_update":
					break;
				case "queue_update":
					setPendingQueueCounts(event.followUp.length);
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
			adoptActiveTurn,
			cancelContextStatsRefresh,
			discardedRuntimeBarrierRef,
			desktopNotifications,
			dispatchConversation,
			failActiveTurn,
			getConversationState,
			notifyTurnResult,
			queueRuntimeAction,
			projectMcpApprovalPendingRef,
			refreshSessionState,
			releaseActiveTurn,
			runtimeGenerationRef,
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
			setRecoveryState({
				status: "failed",
				recoverable: !session.temporary,
				messageKey: session.temporary
					? "chat.temporaryNotRecoverable"
					: "chat.runtimeReconnectRequired",
			});
		});

		return () => {
			disposed = true;
			if (runtimeListenerRef.current === subscription) {
				runtimeListenerRef.current = null;
			}
			void subscription.then((unlisten) => unlisten()).catch(() => undefined);
		};
	}, [activeTurnRef, client, failActiveTurn, session.id, session.temporary]);

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
				runtimeGenerationRef.current = runtimeState.snapshot.generation;
				const agentState = await client.getPiAgentState();
				if (cancelled) return;
				void refreshSessionState(agentState).catch(() => undefined);
				if (!agentState.isStreaming || activeTurnRef.current) return;
				adoptActiveTurn(
					runtimeState.snapshot.generation,
					session.temporary ? session.id : (agentState.sessionId ?? session.id),
				);
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
		adoptActiveTurn,
		client,
		identifiedRef,
		refreshSessionState,
		runtimeGenerationRef,
		session.id,
		session.temporary,
	]);

	return {
		runtimeListenerRef,
		recoveryState,
		clearRecoveryState,
		failActiveTurn,
	};
}
