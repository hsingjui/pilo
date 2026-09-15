/* oxlint-disable no-await-in-loop */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { createChatSessionClient } from "@/lib/chat-session-client";
import { toAppError, type AppError } from "@/lib/app-error";
import { getReplyRunwayHeight } from "@/lib/chat-scroll-state";
import { toConversationAction } from "@/lib/conversation-runtime-adapter";
import { coalesceConversationActions } from "@/lib/conversation-reducer";
import type { ConversationAction } from "@/lib/conversation-types";
import { notifyAgentResult } from "@/lib/desktop-notifications";
import { requestSessionTitle } from "@/lib/sessions";
import {
	chatSubmissionHasContent,
	createChatSubmission,
	summarizeChatImages,
	type ChatImageAttachment,
	type ChatSubmission,
} from "@/lib/chat-submission";
import {
	runtimeErrorMessage,
	type PiAgentState,
	type PiloRuntimeEvent,
} from "@/lib/pi-runtime";
import type { ChatSession } from "@/components/chat/chat-page-utils";
import { createLocalMessageId } from "@/components/chat/use-chat-conversation";

type ChatSessionClient = ReturnType<typeof createChatSessionClient>;

type ActiveTurn = {
	sessionId: string;
	sessionTitle: string;
	projectId: string;
	notificationSessionId: string;
	generation: number | null;
	promptSent: boolean;
	queueReady: boolean;
	preserveQueuedOnRelease: boolean;
};

export type ChatRuntimeRecoveryState =
	| { status: "idle"; recoverable: boolean; message: string }
	| { status: "reconnecting"; recoverable: true; message: string }
	| { status: "recovered"; recoverable: true; message: string }
	| {
			status: "failed";
			recoverable: boolean;
			message: string;
			error?: AppError;
	  };

type BufferedQueuedMessage = {
	turn: ActiveTurn;
	clientMessageId: string;
	submission: ChatSubmission;
	queued: "steer" | "follow_up";
	timestampMs: number;
};

function combineQueuedSubmissions(
	items: readonly BufferedQueuedMessage[],
): ChatSubmission {
	return createChatSubmission(
		items
			.map((item) => item.submission.text)
			.filter(Boolean)
			.join("\n\n"),
		items.flatMap((item) => item.submission.images),
	);
}

function isFrameBatchedAction(action: ConversationAction) {
	return (
		action.type === "assistant_text_delta" ||
		action.type === "assistant_thinking_delta" ||
		action.type === "tool_execution_update"
	);
}

type UseChatRuntimeOptions = {
	session: ChatSession;
	client: ChatSessionClient;
	activeTurnSessionIdRef?: { current: string | null };
	initialMessage?: string;
	initialImages?: readonly ChatImageAttachment[];
	initialQueuedMessages?: readonly string[];
	desktopNotifications: boolean;
	onSessionIdentified?: (sessionId: string) => void;
	dispatchConversationBatch: (
		targetSessionId: string,
		actions: readonly ConversationAction[],
	) => void;
	scrollRef: { current: HTMLDivElement | null };
	scrollToBottom: (smooth?: boolean) => void;
	clearDraft: () => void;
	restoreSubmission: (submission: ChatSubmission) => void;
	recoverSubmission: (submission: ChatSubmission) => void;
	prepareRuntimeConfiguration: (agentState: PiAgentState) => Promise<void>;
	refreshSessionState: () => Promise<void>;
};

export function useChatRuntime({
	session,
	client,
	activeTurnSessionIdRef,
	initialMessage,
	initialImages = [],
	initialQueuedMessages = [],
	desktopNotifications,
	onSessionIdentified,
	dispatchConversationBatch,
	scrollRef,
	scrollToBottom,
	clearDraft,
	restoreSubmission,
	recoverSubmission,
	prepareRuntimeConfiguration,
	refreshSessionState,
}: UseChatRuntimeOptions) {
	const identifiedRef = useRef(onSessionIdentified);
	useEffect(() => {
		identifiedRef.current = onSessionIdentified;
	}, [onSessionIdentified]);
	const activeTurnRef = useRef<ActiveTurn | null>(null);
	const bufferedQueuedMessagesRef = useRef<BufferedQueuedMessage[]>([]);
	const queuedMessagesRef = useRef(new Map<string, BufferedQueuedMessage>());
	const initialQueuedMessagesRef = useRef(initialQueuedMessages);
	const runtimeListenerRef = useRef<ReturnType<typeof client.listen> | null>(
		null,
	);
	const runtimeEventHandlerRef = useRef<(event: PiloRuntimeEvent) => void>(
		() => {},
	);
	const sentInitialPromptsRef = useRef(new Set<string>());
	const autoTitleRequestedRef = useRef(false);
	const [activeTurnSessionId, setActiveTurnSessionId] = useState<string | null>(
		null,
	);
	const [pendingSteering, setPendingSteering] = useState(0);
	const [pendingFollowUps, setPendingFollowUps] = useState(0);
	const [recoveryState, setRecoveryState] = useState<ChatRuntimeRecoveryState>({
		status: "idle",
		recoverable: !session.temporary,
		message: "",
	});
	const recoveryPromiseRef = useRef<Promise<boolean> | null>(null);

	const pendingRuntimeActionsRef = useRef<{
		sessionId: string;
		actions: ConversationAction[];
	} | null>(null);
	const runtimeActionFrameRef = useRef<number | null>(null);
	const flushRuntimeActions = useCallback(() => {
		if (runtimeActionFrameRef.current !== null) {
			cancelAnimationFrame(runtimeActionFrameRef.current);
			runtimeActionFrameRef.current = null;
		}
		const pending = pendingRuntimeActionsRef.current;
		pendingRuntimeActionsRef.current = null;
		if (!pending || pending.actions.length === 0) return;
		dispatchConversationBatch(
			pending.sessionId,
			coalesceConversationActions(pending.actions),
		);
	}, [dispatchConversationBatch]);
	const queueRuntimeAction = useCallback(
		(sessionId: string, action: ConversationAction) => {
			if (
				pendingRuntimeActionsRef.current &&
				pendingRuntimeActionsRef.current.sessionId !== sessionId
			) {
				flushRuntimeActions();
			}
			const pending = pendingRuntimeActionsRef.current ?? {
				sessionId,
				actions: [],
			};
			pending.actions.push(action);
			pendingRuntimeActionsRef.current = pending;
			if (runtimeActionFrameRef.current !== null) return;
			runtimeActionFrameRef.current = requestAnimationFrame(() => {
				runtimeActionFrameRef.current = null;
				flushRuntimeActions();
			});
		},
		[flushRuntimeActions],
	);
	const dispatchConversationActions = useCallback(
		(targetSessionId: string, actions: readonly ConversationAction[]) => {
			flushRuntimeActions();
			dispatchConversationBatch(targetSessionId, actions);
		},
		[dispatchConversationBatch, flushRuntimeActions],
	);
	const dispatchConversation = useCallback(
		(targetSessionId: string, action: ConversationAction) => {
			dispatchConversationActions(targetSessionId, [action]);
		},
		[dispatchConversationActions],
	);

	useEffect(
		() => () => {
			if (runtimeActionFrameRef.current !== null) {
				cancelAnimationFrame(runtimeActionFrameRef.current);
			}
			runtimeActionFrameRef.current = null;
			pendingRuntimeActionsRef.current = null;
		},
		[],
	);

	const takeQueuedMessages = useCallback((turn: ActiveTurn) => {
		const queued = [...queuedMessagesRef.current.values()].filter(
			(item) => item.turn === turn,
		);
		if (queued.length === 0) return queued;
		for (const item of queued) {
			if (queuedMessagesRef.current.get(item.clientMessageId) === item) {
				queuedMessagesRef.current.delete(item.clientMessageId);
			}
		}
		const queuedIds = new Set(queued.map((item) => item.clientMessageId));
		bufferedQueuedMessagesRef.current =
			bufferedQueuedMessagesRef.current.filter(
				(item) => !queuedIds.has(item.clientMessageId),
			);
		return queued;
	}, []);

	const removeQueuedMessagesFromConversation = useCallback(
		(turn: ActiveTurn, items: readonly BufferedQueuedMessage[]) => {
			for (const item of items) {
				dispatchConversation(turn.sessionId, {
					type: "local_user_queue_failed",
					clientMessageId: item.clientMessageId,
				});
			}
		},
		[dispatchConversation],
	);

	const restoreQueuedMessages = useCallback(
		(items: readonly BufferedQueuedMessage[]) => {
			if (items.length === 0) return;
			recoverSubmission(combineQueuedSubmissions(items));
		},
		[recoverSubmission],
	);

	const releaseActiveTurn = useCallback(
		(turn: ActiveTurn, options: { preserveQueued?: boolean } = {}) => {
			if (activeTurnRef.current !== turn) return;
			if (!options.preserveQueued && !turn.preserveQueuedOnRelease) {
				const discarded = takeQueuedMessages(turn);
				removeQueuedMessagesFromConversation(turn, discarded);
				restoreQueuedMessages(discarded);
			}
			activeTurnRef.current = null;
			if (activeTurnSessionIdRef?.current === turn.sessionId) {
				activeTurnSessionIdRef.current = null;
			}
			setActiveTurnSessionId(null);
			setPendingSteering(0);
			setPendingFollowUps(0);
		},
		[
			activeTurnSessionIdRef,
			removeQueuedMessagesFromConversation,
			restoreQueuedMessages,
			takeQueuedMessages,
		],
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
		[desktopNotifications, dispatchConversation, releaseActiveTurn],
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
	}, [client, refreshSessionState, session.sessionPath, session.temporary]);

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
				// `stopped` is also emitted for intentional client.stop() calls (for
				// example when replacing a controller). Only an active turn makes that
				// state unexpected enough to reconnect automatically.
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

			const action = toConversationAction(event);
			if (action) {
				if (isFrameBatchedAction(action)) {
					queueRuntimeAction(turn.sessionId, action);
				} else {
					dispatchConversation(turn.sessionId, action);
				}
			}

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
					for (const [id, item] of queuedMessagesRef.current) {
						if (item.turn === turn && item.submission.text === event.text) {
							queuedMessagesRef.current.delete(id);
							break;
						}
					}
					// The local submit / queue path already positioned the viewport. This
					// runtime echo can arrive after the reader has started scrolling up;
					// forcing bottom here would re-enable sticky follow and yank the page.
					break;
				case "queue_update":
					setPendingSteering(event.steering.length);
					setPendingFollowUps(event.followUp.length);
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
			desktopNotifications,
			dispatchConversation,
			failActiveTurn,
			queueRuntimeAction,
			recoverRuntime,
			refreshSessionState,
			releaseActiveTurn,
			session.temporary,
		],
	);

	useEffect(() => {
		runtimeEventHandlerRef.current = handleRuntimeEvent;
	}, [handleRuntimeEvent]);

	useEffect(() => {
		let disposed = false;
		const subscription = client.listen((event) => {
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
	}, [client, failActiveTurn, recoverRuntime, session.temporary]);

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
				if (activeTurnSessionIdRef)
					activeTurnSessionIdRef.current = turn.sessionId;
				setActiveTurnSessionId(turn.sessionId);
				setPendingSteering(agentState.pendingMessageCount ?? 0);
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
		client,
		activeTurnSessionIdRef,
		session.id,
		session.projectRecord.id,
		session.temporary,
		session.title,
	]);

	const sendQueuedMessage = useCallback(
		(item: BufferedQueuedMessage) => {
			const request =
				item.queued === "steer"
					? client.sendPiSteer(item.submission.text, item.submission.images)
					: client.sendPiFollowUp(item.submission.text, item.submission.images);
			void request.catch((error) => {
				// A stale RPC from an older turn must not delete a message that has
				// already been rebound to a newer turn.
				if (queuedMessagesRef.current.get(item.clientMessageId) !== item)
					return;
				queuedMessagesRef.current.delete(item.clientMessageId);
				bufferedQueuedMessagesRef.current =
					bufferedQueuedMessagesRef.current.filter(
						(candidate) => candidate.clientMessageId !== item.clientMessageId,
					);
				dispatchConversation(item.turn.sessionId, {
					type: "local_user_queue_failed",
					clientMessageId: item.clientMessageId,
				});
				recoverSubmission(item.submission);
				toast.error(
					item.queued === "steer" ? "无法调整当前回复" : "无法排队发送",
					{ description: runtimeErrorMessage(error) },
				);
			});
		},
		[client, dispatchConversation, recoverSubmission],
	);

	const flushBufferedQueuedMessages = useCallback(
		(turn: ActiveTurn) => {
			const ready = bufferedQueuedMessagesRef.current.filter(
				(item) => item.turn === turn,
			);
			if (ready.length === 0) return;
			bufferedQueuedMessagesRef.current =
				bufferedQueuedMessagesRef.current.filter((item) => item.turn !== turn);
			for (const item of ready) sendQueuedMessage(item);
		},
		[sendQueuedMessage],
	);

	const requestAutoTitle = useCallback(
		(message: string) => {
			const prompt = message.trim();
			if (
				session.temporary ||
				session.sessionPath ||
				autoTitleRequestedRef.current ||
				!prompt
			) {
				return;
			}
			autoTitleRequestedRef.current = true;
			void requestSessionTitle(session.projectRecord.id, prompt)
				.then(async (title) => {
					if (!title) return;
					const state = await client.getPiAgentState();
					if (state.sessionName?.trim()) return;
					await client.setPiSessionName(title);
					await refreshSessionState();
				})
				.catch((error) => {
					console.warn("Failed to generate session title", error);
				});
		},
		[
			client,
			refreshSessionState,
			session.projectRecord.id,
			session.sessionPath,
			session.temporary,
		],
	);

	const beginTurn = useCallback(
		async (submission: ChatSubmission, appendUserMessage = true) => {
			const normalized = createChatSubmission(
				submission.text,
				submission.images,
			);
			if (!chatSubmissionHasContent(normalized) || activeTurnRef.current)
				return;
			const trimmed = normalized.text;
			const viewport = scrollRef.current;
			const replyRunwayPx = viewport
				? getReplyRunwayHeight({
						viewportHeight: viewport.clientHeight,
						scrollHeight: viewport.scrollHeight,
						enabled: appendUserMessage,
					})
				: undefined;

			const turn: ActiveTurn = {
				sessionId: session.id,
				sessionTitle: session.title,
				projectId: session.projectRecord.id,
				notificationSessionId: session.id,
				generation: null,
				promptSent: false,
				queueReady: false,
				preserveQueuedOnRelease: false,
			};
			activeTurnRef.current = turn;
			if (activeTurnSessionIdRef) {
				activeTurnSessionIdRef.current = turn.sessionId;
			}
			setActiveTurnSessionId(turn.sessionId);

			const submittedAtMs = Date.now();
			const clientMessageId = createLocalMessageId("user");
			dispatchConversationActions(turn.sessionId, [
				{
					type: "local_user_submit",
					clientMessageId,
					text: trimmed,
					images: summarizeChatImages(normalized.images),
					timestampMs: submittedAtMs,
					replyRunwayPx,
					appendMessage: appendUserMessage,
				},
				{
					type: "local_assistant_pending",
					timestampMs: submittedAtMs,
					replyRunwayPx,
				},
			]);
			clearDraft();
			requestAnimationFrame(() => scrollToBottom(false));

			try {
				const subscription = runtimeListenerRef.current;
				if (!subscription) {
					throw new Error("Pi Runtime 事件通道尚未就绪。");
				}
				await subscription;
				const snapshot = await client.ensure();
				if (activeTurnRef.current !== turn) return;
				turn.generation = snapshot.generation;
				const agentState = await client.getPiAgentState();
				if (activeTurnRef.current !== turn) return;
				if (agentState.sessionId && !session.temporary) {
					turn.notificationSessionId = agentState.sessionId;
					identifiedRef.current?.(agentState.sessionId);
				}
				await prepareRuntimeConfiguration(agentState);
				if (activeTurnRef.current !== turn) return;
				turn.promptSent = true;
				await client.sendPiPrompt(trimmed, normalized.images);
				if (activeTurnRef.current !== turn) return;
				requestAutoTitle(trimmed);
				turn.queueReady = true;
				flushBufferedQueuedMessages(turn);
				setRecoveryState({
					status: "idle",
					recoverable: !session.temporary,
					message: "",
				});
			} catch (error) {
				failActiveTurn(turn, runtimeErrorMessage(error));
			}
		},
		[
			activeTurnSessionIdRef,
			clearDraft,
			client,
			dispatchConversationActions,
			failActiveTurn,
			flushBufferedQueuedMessages,
			prepareRuntimeConfiguration,
			requestAutoTitle,
			scrollRef,
			scrollToBottom,
			session.id,
			session.projectRecord.id,
			session.temporary,
			session.title,
		],
	);

	const handleSubmit = useCallback(
		(submission: ChatSubmission) => {
			void beginTurn(submission);
		},
		[beginTurn],
	);

	const queueMessage = useCallback(
		(submission: ChatSubmission, queued: "steer" | "follow_up") => {
			const normalized = createChatSubmission(
				submission.text,
				submission.images,
			);
			const turn = activeTurnRef.current;
			if (
				!chatSubmissionHasContent(normalized) ||
				!turn ||
				turn.sessionId !== session.id
			) {
				return;
			}

			const messageId = createLocalMessageId("user");
			const timestampMs = Date.now();
			dispatchConversation(turn.sessionId, {
				type: "local_user_queue",
				clientMessageId: messageId,
				text: normalized.text,
				images: summarizeChatImages(normalized.images),
				queueKind: queued,
				timestampMs,
			});
			clearDraft();

			const item: BufferedQueuedMessage = {
				turn,
				clientMessageId: messageId,
				submission: normalized,
				queued,
				timestampMs,
			};
			queuedMessagesRef.current.set(messageId, item);
			if (turn.generation === null || !turn.queueReady) {
				bufferedQueuedMessagesRef.current.push(item);
				return;
			}
			sendQueuedMessage(item);
		},
		[clearDraft, dispatchConversation, sendQueuedMessage, session.id],
	);

	const replayQueuedMessages = useCallback(
		async (turn: ActiveTurn, excludedId?: string) => {
			const queued = [...queuedMessagesRef.current.values()].filter(
				(item) => item.turn === turn && item.clientMessageId !== excludedId,
			);
			await client.clearPiQueue();
			for (const item of queued) {
				if (item.queued === "steer") {
					await client.sendPiSteer(
						item.submission.text,
						item.submission.images,
					);
				} else {
					await client.sendPiFollowUp(
						item.submission.text,
						item.submission.images,
					);
				}
			}
		},
		[client],
	);

	const handleEditQueued = useCallback(
		async (clientMessageId: string) => {
			const item = queuedMessagesRef.current.get(clientMessageId);
			const turn = activeTurnRef.current;
			if (!item || !turn || item.turn !== turn || turn.sessionId !== session.id)
				return;
			try {
				if (turn.queueReady) await replayQueuedMessages(turn, clientMessageId);
				bufferedQueuedMessagesRef.current =
					bufferedQueuedMessagesRef.current.filter(
						(candidate) => candidate.clientMessageId !== clientMessageId,
					);
				queuedMessagesRef.current.delete(clientMessageId);
				dispatchConversation(turn.sessionId, {
					type: "local_user_queue_failed",
					clientMessageId,
				});
				restoreSubmission(item.submission);
			} catch (error) {
				const remaining = takeQueuedMessages(turn);
				try {
					await client.clearPiQueue();
				} catch {
					// The runtime may already be unavailable. Local state still needs to
					// become authoritative instead of leaving a half-replayed queue visible.
				}
				removeQueuedMessagesFromConversation(turn, remaining);
				restoreQueuedMessages(remaining);
				toast.error("无法取回待处理消息，已将队列恢复到输入框", {
					description: runtimeErrorMessage(error),
				});
			}
		},
		[
			client,
			dispatchConversation,
			removeQueuedMessagesFromConversation,
			replayQueuedMessages,
			restoreQueuedMessages,
			restoreSubmission,
			session.id,
			takeQueuedMessages,
		],
	);

	const handleSendQueuedNow = useCallback(
		async (clientMessageId: string) => {
			const item = queuedMessagesRef.current.get(clientMessageId);
			const turn = activeTurnRef.current;
			if (!item || !turn || item.turn !== turn || turn.sessionId !== session.id)
				return;

			const queued = [...queuedMessagesRef.current.values()].filter(
				(candidate) => candidate.turn === turn,
			);
			const remaining = queued.filter(
				(candidate) => candidate.clientMessageId !== clientMessageId,
			);
			turn.preserveQueuedOnRelease = true;

			try {
				let runtimeStopped = false;
				let piQueueCleared = false;
				if (turn.queueReady) {
					try {
						await client.clearPiQueue();
						piQueueCleared = true;
					} catch (error) {
						if (session.temporary) throw error;
						console.warn(
							"Pi queue clear failed; restarting runtime before send-now",
							error,
						);
						await client.stop();
						runtimeStopped = true;
					}
				}
				if (!runtimeStopped && turn.generation !== null && turn.promptSent) {
					try {
						await client.abortPiReply();
					} catch (error) {
						if (session.temporary) {
							if (piQueueCleared) await replayQueuedMessages(turn);
							throw error;
						}
						console.warn(
							"Pi abort failed; restarting runtime before send-now",
							error,
						);
						await client.stop();
					}
				}

				const detached = takeQueuedMessages(turn);
				removeQueuedMessagesFromConversation(turn, detached);
				dispatchConversation(turn.sessionId, {
					type: "local_turn_abort",
					timestampMs: Date.now(),
				});
				releaseActiveTurn(turn, { preserveQueued: true });

				const nextTurnPromise = beginTurn(item.submission);
				const nextTurn = activeTurnRef.current;
				if (!nextTurn) {
					restoreQueuedMessages(remaining);
					await nextTurnPromise;
					return;
				}

				for (const queuedItem of remaining) {
					const rebound: BufferedQueuedMessage = {
						...queuedItem,
						turn: nextTurn,
					};
					queuedMessagesRef.current.set(rebound.clientMessageId, rebound);
					bufferedQueuedMessagesRef.current.push(rebound);
					dispatchConversation(nextTurn.sessionId, {
						type: "local_user_queue",
						clientMessageId: rebound.clientMessageId,
						text: rebound.submission.text,
						images: summarizeChatImages(rebound.submission.images),
						queueKind: rebound.queued,
						timestampMs: rebound.timestampMs,
					});
				}
				await nextTurnPromise;
			} catch (error) {
				if (activeTurnRef.current === turn) {
					turn.preserveQueuedOnRelease = false;
				} else {
					const stranded = takeQueuedMessages(turn);
					removeQueuedMessagesFromConversation(turn, stranded);
					restoreQueuedMessages(stranded);
				}
				toast.error("无法立即发送消息", {
					description: runtimeErrorMessage(error),
				});
			}
		},
		[
			beginTurn,
			client,
			dispatchConversation,
			releaseActiveTurn,
			removeQueuedMessagesFromConversation,
			replayQueuedMessages,
			restoreQueuedMessages,
			session.id,
			session.temporary,
			takeQueuedMessages,
		],
	);

	const handleSteer = useCallback(
		(submission: ChatSubmission) => queueMessage(submission, "steer"),
		[queueMessage],
	);

	const handleFollowUp = useCallback(
		(submission: ChatSubmission) => queueMessage(submission, "follow_up"),
		[queueMessage],
	);

	const handleStop = useCallback(() => {
		const turn = activeTurnRef.current;
		if (!turn || turn.sessionId !== session.id) return;
		const queued = takeQueuedMessages(turn);
		removeQueuedMessagesFromConversation(turn, queued);
		restoreQueuedMessages(queued);
		dispatchConversation(turn.sessionId, {
			type: "local_turn_abort",
			timestampMs: Date.now(),
		});
		releaseActiveTurn(turn, { preserveQueued: true });
		if (turn.generation === null || !turn.promptSent) return;

		void (async () => {
			let mustStopRuntime = false;
			if (turn.queueReady) {
				try {
					await client.clearPiQueue();
				} catch (error) {
					console.warn("Pi queue clear failed while stopping", error);
					mustStopRuntime = true;
				}
			}
			if (!mustStopRuntime) {
				try {
					await client.abortPiReply();
				} catch (error) {
					console.warn("Pi abort failed; stopping chat runtime", error);
					mustStopRuntime = true;
				}
			}
			if (!mustStopRuntime) return;
			try {
				await client.stop();
			} catch (stopError) {
				toast.error("停止 Pi 失败", {
					description: runtimeErrorMessage(stopError),
				});
			}
		})();
	}, [
		client,
		dispatchConversation,
		releaseActiveTurn,
		removeQueuedMessagesFromConversation,
		restoreQueuedMessages,
		session.id,
		takeQueuedMessages,
	]);

	useEffect(() => {
		if (activeTurnSessionId !== null) return;
		const deferred = initialQueuedMessagesRef.current;
		initialQueuedMessagesRef.current = [];

		const initialSubmission = createChatSubmission(
			initialMessage ?? "",
			initialImages,
		);
		if (chatSubmissionHasContent(initialSubmission)) {
			const key = `${session.id}:${initialMessage ?? ""}:${initialImages.map((image) => image.id).join(",")}`;
			if (sentInitialPromptsRef.current.has(key)) return;
			sentInitialPromptsRef.current.add(key);
			void beginTurn(initialSubmission, false);
			for (const message of deferred)
				queueMessage(createChatSubmission(message), "follow_up");
			return;
		}

		const [first, ...rest] = deferred;
		if (!first) return;
		void beginTurn(createChatSubmission(first));
		for (const message of rest)
			queueMessage(createChatSubmission(message), "follow_up");
	}, [
		activeTurnSessionId,
		beginTurn,
		initialImages,
		initialMessage,
		queueMessage,
		session.id,
	]);

	return {
		activeTurnSessionId,
		pendingSteering,
		pendingFollowUps,
		running: activeTurnSessionId === session.id,
		runtimeBusy:
			activeTurnSessionId !== null || recoveryState.status === "reconnecting",
		recoveryState,
		handleReconnect: recoverRuntime,
		handleSubmit,
		handleSteer,
		handleFollowUp,
		handleEditQueued,
		handleSendQueuedNow,
		handleStop,
	};
}
