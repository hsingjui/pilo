import { useCallback, useEffect, useRef, useState } from "react";

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
		message: "",
	});
	const recoveryPromiseRef = useRef<Promise<boolean> | null>(null);

	const clearRecoveryState = useCallback(() => {
		setRecoveryState({
			status: "idle",
			recoverable: !session.temporary,
			message: "",
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
				message:
					"临时会话不会写入 Session 文件，Pi 进程中断后无法恢复原上下文。",
			});
			return false;
		}
		if (recoveryPromiseRef.current) return recoveryPromiseRef.current;

		const recovery = (async () => {
			setRecoveryState({
				status: "reconnecting",
				recoverable: true,
				message: "正在重新连接运行环境并载入原 Session…",
			});
			try {
				const runtimeState = await client.state();
				const resumePath = runtimeState?.sessionPath ?? session.sessionPath;
				if (!resumePath) {
					throw new Error("当前 Session 尚未持久化，无法安全恢复连接。");
				}

				const snapshot = await client.ensure();
				if (snapshot.state !== "running") {
					throw new Error(`Pi Runtime 恢复后状态异常：${snapshot.state}`);
				}
				const agentState = await client.getPiAgentState();
				if (!agentState.sessionFile) {
					throw new Error("Pi 未返回恢复后的 Session 路径。");
				}
				if (agentState.sessionId) identifiedRef.current?.(agentState.sessionId);
				await refreshSessionState();
				setRecoveryState({
					status: "recovered",
					recoverable: true,
					message:
						"已重新连接原 Session。中断的上一轮不会自动重放，可直接继续发送消息。",
				});
				return true;
			} catch (error) {
				const appError = toAppError(error);
				setRecoveryState({
					status: "failed",
					recoverable: appError.retryable,
					message: appError.message,
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
					? { status: "idle", recoverable: true, message: "" }
					: current,
			);
		}, 5000);
		return () => window.clearTimeout(timer);
	}, [recoveryState.status]);

	const handleRuntimeEvent = useCallback(
		(event: PiloRuntimeEvent) => {
			recordChatRuntimeEvent();
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
							? "Pi 进程运行失败。"
							: "Pi 进程在回复完成前已停止。",
					);
				}
				if (event.state === "stopped" && !interruptedActiveTurn) return;
				if (session.temporary) {
					setRecoveryState({
						status: "failed",
						recoverable: false,
						message:
							"临时会话不会写入 Session 文件，Pi 进程中断后无法恢复原上下文。",
					});
				} else {
					void recoverRuntime();
				}
				return;
			}

			const turn = activeTurnRef.current;
			if (
				!turn ||
				turn.generation === null ||
				event.generation !== turn.generation
			) {
				return;
			}

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
						void refreshSessionState().catch(() => undefined);
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
					void refreshSessionState().catch(() => undefined);
					releaseActiveTurn(turn);
					break;
				case "user_message_start":
					acknowledgeQueuedMessage(turn, event.text);
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
				case "assistant_text_snapshot":
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
			desktopNotifications,
			dispatchConversation,
			failActiveTurn,
			queueRuntimeAction,
			recoverRuntime,
			refreshSessionState,
			releaseActiveTurn,
			session.temporary,
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
					message:
						"临时会话不会写入 Session 文件，运行环境断开后无法恢复原上下文。",
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
					message: "已重新连接正在进行的 Pi 回复。",
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
