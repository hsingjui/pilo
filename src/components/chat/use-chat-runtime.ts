import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { createChatSessionClient } from "@/lib/chat-session-client";
import { getReplyRunwayHeight } from "@/lib/chat-scroll-state";
import { toConversationAction } from "@/lib/conversation-runtime-adapter";
import { coalesceConversationActions } from "@/lib/conversation-reducer";
import type { ConversationAction } from "@/lib/conversation-types";
import { notifyAgentResult } from "@/lib/desktop-notifications";
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
};

type BufferedQueuedMessage = {
	turn: ActiveTurn;
	clientMessageId: string;
	text: string;
	queued: "steer" | "follow_up";
};

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
	restoreDraftIfEmpty: (value: string) => void;
	prepareRuntimeConfiguration: (agentState: PiAgentState) => Promise<void>;
	refreshSessionState: () => Promise<void>;
};

export function useChatRuntime({
	session,
	client,
	activeTurnSessionIdRef,
	initialMessage,
	initialQueuedMessages = [],
	desktopNotifications,
	onSessionIdentified,
	dispatchConversationBatch,
	scrollRef,
	scrollToBottom,
	clearDraft,
	restoreDraftIfEmpty,
	prepareRuntimeConfiguration,
	refreshSessionState,
}: UseChatRuntimeOptions) {
	const identifiedRef = useRef(onSessionIdentified);
	useEffect(() => {
		identifiedRef.current = onSessionIdentified;
	}, [onSessionIdentified]);
	const activeTurnRef = useRef<ActiveTurn | null>(null);
	const bufferedQueuedMessagesRef = useRef<BufferedQueuedMessage[]>([]);
	const initialQueuedMessagesRef = useRef(initialQueuedMessages);
	const runtimeListenerRef = useRef<ReturnType<typeof client.listen> | null>(
		null,
	);
	const runtimeEventHandlerRef = useRef<(event: PiloRuntimeEvent) => void>(
		() => {},
	);
	const sentInitialPromptsRef = useRef(new Set<string>());
	const [activeTurnSessionId, setActiveTurnSessionId] = useState<string | null>(
		null,
	);
	const [pendingSteering, setPendingSteering] = useState(0);
	const [pendingFollowUps, setPendingFollowUps] = useState(0);

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

	const discardBufferedQueuedMessages = useCallback(
		(turn: ActiveTurn) => {
			const discarded = bufferedQueuedMessagesRef.current.filter(
				(item) => item.turn === turn,
			);
			if (discarded.length === 0) return;
			bufferedQueuedMessagesRef.current =
				bufferedQueuedMessagesRef.current.filter((item) => item.turn !== turn);
			for (const item of discarded) {
				dispatchConversation(turn.sessionId, {
					type: "local_user_queue_failed",
					clientMessageId: item.clientMessageId,
				});
			}
			restoreDraftIfEmpty(discarded.map((item) => item.text).join("\n\n"));
		},
		[dispatchConversation, restoreDraftIfEmpty],
	);

	const releaseActiveTurn = useCallback(
		(turn: ActiveTurn) => {
			if (activeTurnRef.current !== turn) return;
			discardBufferedQueuedMessages(turn);
			activeTurnRef.current = null;
			if (activeTurnSessionIdRef?.current === turn.sessionId) {
				activeTurnSessionIdRef.current = null;
			}
			setActiveTurnSessionId(null);
			setPendingSteering(0);
			setPendingFollowUps(0);
		},
		[activeTurnSessionIdRef, discardBufferedQueuedMessages],
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

	const handleRuntimeEvent = useCallback(
		(event: PiloRuntimeEvent) => {
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
					if (event.state === "failed" || event.state === "stopped") {
						failActiveTurn(
							turn,
							event.state === "failed"
								? "Pi 进程运行失败。"
								: "Pi 进程在回复完成前已停止。",
						);
					}
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
			refreshSessionState,
			releaseActiveTurn,
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
		});

		return () => {
			disposed = true;
			if (runtimeListenerRef.current === subscription) {
				runtimeListenerRef.current = null;
			}
			void subscription.then((unlisten) => unlisten()).catch(() => undefined);
		};
	}, [client, failActiveTurn]);

	const sendQueuedMessage = useCallback(
		(item: BufferedQueuedMessage) => {
			const request =
				item.queued === "steer"
					? client.sendPiSteer(item.text)
					: client.sendPiFollowUp(item.text);
			void request.catch((error) => {
				dispatchConversation(item.turn.sessionId, {
					type: "local_user_queue_failed",
					clientMessageId: item.clientMessageId,
				});
				restoreDraftIfEmpty(item.text);
				toast.error(
					item.queued === "steer" ? "无法调整当前回复" : "无法排队发送",
					{ description: runtimeErrorMessage(error) },
				);
			});
		},
		[client, dispatchConversation, restoreDraftIfEmpty],
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

	const beginTurn = useCallback(
		async (text: string, appendUserMessage = true) => {
			const trimmed = text.trim();
			if (!trimmed || activeTurnRef.current) return;
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
				if (agentState.sessionId) {
					turn.notificationSessionId = agentState.sessionId;
					identifiedRef.current?.(agentState.sessionId);
				}
				await prepareRuntimeConfiguration(agentState);
				if (activeTurnRef.current !== turn) return;
				turn.promptSent = true;
				await client.sendPiPrompt(trimmed);
				if (activeTurnRef.current !== turn) return;
				turn.queueReady = true;
				flushBufferedQueuedMessages(turn);
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
			scrollRef,
			scrollToBottom,
			session.id,
			session.projectRecord.id,
			session.title,
		],
	);

	const handleSubmit = useCallback(
		(text: string) => {
			void beginTurn(text);
		},
		[beginTurn],
	);

	const queueMessage = useCallback(
		(text: string, queued: "steer" | "follow_up") => {
			const trimmed = text.trim();
			const turn = activeTurnRef.current;
			if (!trimmed || !turn || turn.sessionId !== session.id) {
				return;
			}

			const messageId = createLocalMessageId("user");
			dispatchConversation(turn.sessionId, {
				type: "local_user_queue",
				clientMessageId: messageId,
				text: trimmed,
				queueKind: queued,
				timestampMs: Date.now(),
			});
			clearDraft();

			const item: BufferedQueuedMessage = {
				turn,
				clientMessageId: messageId,
				text: trimmed,
				queued,
			};
			if (turn.generation === null || !turn.queueReady) {
				bufferedQueuedMessagesRef.current.push(item);
				return;
			}
			sendQueuedMessage(item);
		},
		[clearDraft, dispatchConversation, sendQueuedMessage, session.id],
	);

	const handleSteer = useCallback(
		(text: string) => queueMessage(text, "steer"),
		[queueMessage],
	);

	const handleFollowUp = useCallback(
		(text: string) => queueMessage(text, "follow_up"),
		[queueMessage],
	);

	const handleStop = useCallback(() => {
		const turn = activeTurnRef.current;
		if (!turn || turn.sessionId !== session.id) return;
		if (turn.generation === null || !turn.promptSent) {
			dispatchConversation(turn.sessionId, {
				type: "local_turn_abort",
				timestampMs: Date.now(),
			});
			releaseActiveTurn(turn);
			return;
		}
		void client.abortPiReply().catch((error) => {
			failActiveTurn(turn, runtimeErrorMessage(error));
		});
	}, [
		client,
		dispatchConversation,
		failActiveTurn,
		releaseActiveTurn,
		session.id,
	]);

	useEffect(() => {
		if (activeTurnSessionId !== null) return;
		const deferred = initialQueuedMessagesRef.current;
		initialQueuedMessagesRef.current = [];

		if (initialMessage) {
			const key = `${session.id}:${initialMessage}`;
			if (sentInitialPromptsRef.current.has(key)) return;
			sentInitialPromptsRef.current.add(key);
			void beginTurn(initialMessage, false);
			for (const message of deferred) queueMessage(message, "follow_up");
			return;
		}

		const [first, ...rest] = deferred;
		if (!first) return;
		void beginTurn(first);
		for (const message of rest) queueMessage(message, "follow_up");
	}, [
		activeTurnSessionId,
		beginTurn,
		initialMessage,
		queueMessage,
		session.id,
	]);

	return {
		activeTurnSessionId,
		pendingSteering,
		pendingFollowUps,
		running: activeTurnSessionId === session.id,
		runtimeBusy: activeTurnSessionId !== null,
		handleSubmit,
		handleSteer,
		handleFollowUp,
		handleStop,
	};
}
