import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ChatSession } from "@/components/chat/chat-page-utils";
import type {
	ActiveTurn,
	BeginTurn,
	ChatSessionClient,
	DiscardedRuntimeBarrier,
} from "@/components/chat/chat-runtime-types";
import {
	dispatchRuntimeEventToConversation,
	useChatRuntimeEvents,
} from "@/components/chat/use-chat-runtime-events";
import { useChatRuntimeQueue } from "@/components/chat/use-chat-runtime-queue";
import { createLocalMessageId } from "@/components/chat/chat-conversation-model";
import { useRuntimeConversationDispatch } from "@/components/chat/use-runtime-conversation-dispatch";
import { getReplyRunwayHeight } from "@/lib/chat/chat-scroll-state";
import { registerChatRuntimeReplayTarget } from "@/lib/chat/chat-runtime-replay";
import {
	chatSubmissionHasContent,
	createChatSubmission,
	summarizeChatImages,
	type ChatImageAttachment,
	type ChatSubmission,
} from "@/lib/chat/chat-submission";
import { cacheLocalChatImages } from "@/lib/chat/chat-image-media";
import type {
	ConversationAction,
	ConversationState,
} from "@/lib/chat/conversation-types";
import { runtimeErrorMessage, type PiAgentState } from "@/lib/api/pi-runtime";
import { requestSessionTitle } from "@/lib/api/sessions";
import { chatRuntimeHasOpenTurn } from "@/lib/chat/chat-session-runtime-model";

export type { ChatRuntimeRecoveryState } from "@/components/chat/chat-runtime-types";

type UseChatRuntimeOptions = {
	active: boolean;
	session: ChatSession;
	sessionTitle: string;
	client: ChatSessionClient;
	activeTurnSessionIdRef?: { current: string | null };
	projectMcpApprovalPendingRef: { current: boolean };
	initialMessage?: string;
	initialImages?: readonly ChatImageAttachment[];
	initialQueuedMessages?: readonly string[];
	desktopNotifications: boolean;
	onSessionIdentified?: (sessionId: string) => void;
	getConversationState: () => ConversationState | undefined;
	dispatchConversationBatch: (
		targetSessionId: string,
		actions: readonly ConversationAction[],
	) => void;
	resetConversation: () => void;
	getActivePresentationIntervalMs: () => number;
	scrollRef: { current: HTMLDivElement | null };
	scrollToBottom: (smooth?: boolean) => void;
	clearDraft: () => void;
	restoreSubmission: (submission: ChatSubmission) => void;
	recoverSubmission: (submission: ChatSubmission) => void;
	prepareRuntimeConfiguration: (agentState: PiAgentState) => Promise<void>;
	refreshSessionState: (agentState?: PiAgentState) => Promise<void>;
	refreshSessionStats: () => Promise<void>;
};

export function useChatRuntime({
	active,
	session,
	sessionTitle,
	client,
	activeTurnSessionIdRef,
	projectMcpApprovalPendingRef,
	initialMessage,
	initialImages = [],
	initialQueuedMessages = [],
	desktopNotifications,
	onSessionIdentified,
	getConversationState,
	dispatchConversationBatch,
	resetConversation,
	getActivePresentationIntervalMs,
	scrollRef,
	scrollToBottom,
	clearDraft,
	restoreSubmission,
	recoverSubmission,
	prepareRuntimeConfiguration,
	refreshSessionState,
	refreshSessionStats,
}: UseChatRuntimeOptions) {
	const { t } = useTranslation();
	const identifiedRef = useRef(onSessionIdentified);
	useEffect(() => {
		identifiedRef.current = onSessionIdentified;
	}, [onSessionIdentified]);

	const activeTurnRef = useRef<ActiveTurn | null>(null);
	const runtimeGenerationRef = useRef<number | null>(null);
	const discardedRuntimeBarrierRef = useRef<DiscardedRuntimeBarrier | null>(
		null,
	);
	const initialQueuedMessagesRef = useRef(initialQueuedMessages);
	const sentInitialPromptsRef = useRef(new Set<string>());
	const autoTitlePromiseRef = useRef<Promise<string | undefined> | null>(null);
	const beginTurnRef = useRef<BeginTurn | null>(null);
	const pendingProjectMcpTurnRef = useRef<{
		turn: ActiveTurn;
		submission: ChatSubmission;
		clientMessageId: string;
	} | null>(null);
	const [activeTurnSessionId, setActiveTurnSessionId] = useState<string | null>(
		null,
	);

	const {
		queueRuntimeAction,
		dispatchConversationActions,
		dispatchConversation,
		flushRuntimeActions,
		discardRuntimeActions,
	} = useRuntimeConversationDispatch(
		active,
		dispatchConversationBatch,
		getActivePresentationIntervalMs,
	);

	const {
		pendingFollowUps,
		setPendingQueueCounts,
		acknowledgeQueuedMessage,
		releaseActiveTurn,
		flushBufferedQueuedMessages,
		queueMessage,
		handleSteer,
		handleFollowUp,
		handleEditQueued,
		handleSendQueuedNow,
		handleSendNow,
		handleStop,
	} = useChatRuntimeQueue({
		session,
		client,
		activeTurnRef,
		activeTurnSessionIdRef,
		runtimeGenerationRef,
		discardedRuntimeBarrierRef,
		beginTurnRef,
		setActiveTurnSessionId,
		dispatchConversation,
		clearDraft,
		restoreSubmission,
		recoverSubmission,
	});

	const {
		runtimeListenerRef,
		recoveryState,
		clearRecoveryState,
		failActiveTurn,
	} = useChatRuntimeEvents({
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
	});

	useEffect(() => {
		if (!import.meta.env.DEV) return;
		return registerChatRuntimeReplayTarget({
			projectId: session.projectRecord.id,
			sessionId: session.id,
			isActive: () => active,
			isBusy: () =>
				activeTurnRef.current !== null ||
				recoveryState.status === "reconnecting",
			dispatchEvent: (event) =>
				dispatchRuntimeEventToConversation(
					event,
					session.id,
					dispatchConversation,
					queueRuntimeAction,
				),
			flush: flushRuntimeActions,
			reset: () => {
				discardRuntimeActions();
				resetConversation();
			},
		});
	}, [
		active,
		discardRuntimeActions,
		dispatchConversation,
		flushRuntimeActions,
		queueRuntimeAction,
		recoveryState.status,
		resetConversation,
		session.id,
		session.projectRecord.id,
	]);

	const requestAutoTitle = useCallback(
		(message: string) => {
			const prompt = message.trim();
			if (
				session.temporary ||
				session.sessionPath ||
				autoTitlePromiseRef.current ||
				!prompt
			) {
				return autoTitlePromiseRef.current ?? undefined;
			}
			autoTitlePromiseRef.current = requestSessionTitle(
				session.projectRecord.id,
				prompt,
			)
				.then(async (title) => {
					if (!title) return;
					const state = await client.getPiAgentState();
					const name = state.sessionName?.trim();
					if (name) return name;
					await client.setPiSessionName(title);
					await refreshSessionState();
					return title;
				})
				.catch((error) => {
					console.warn("Failed to generate session title", error);
					return undefined;
				});
			return autoTitlePromiseRef.current;
		},
		[
			client,
			refreshSessionState,
			session.projectRecord.id,
			session.sessionPath,
			session.temporary,
		],
	);

	const runTurn = useCallback(
		async (
			turn: ActiveTurn,
			submission: ChatSubmission,
			clientMessageId: string,
		) => {
			const subscription = runtimeListenerRef.current;
			if (!subscription) {
				throw new Error(t("errors.piEventChannel"));
			}
			await subscription;
			const snapshot = await client.ensure();
			if (activeTurnRef.current !== turn) return;
			runtimeGenerationRef.current = snapshot.generation;
			turn.generation = snapshot.generation;
			const agentState = await client.getPiAgentState();
			if (activeTurnRef.current !== turn) return;
			void refreshSessionState(agentState).catch(() => undefined);
			if (agentState.sessionId && !session.temporary) {
				turn.notificationSessionId = agentState.sessionId;
				identifiedRef.current?.(agentState.sessionId);
			}
			await prepareRuntimeConfiguration(agentState);
			if (activeTurnRef.current !== turn) return;
			turn.promptSent = true;
			const promptResult = client
				.sendPiPrompt(submission.text, submission.images)
				.catch((error: unknown) => {
					if (activeTurnRef.current === turn) {
						dispatchConversation(turn.sessionId, {
							type: "local_user_queue_failed",
							clientMessageId,
						});
						recoverSubmission(submission);
					}
					throw error;
				});
			turn.sessionTitleReady = promptResult
				.then((result) =>
					result?.disposition === "handled"
						? undefined
						: requestAutoTitle(submission.text),
				)
				.catch(() => undefined);
			const result = await promptResult;
			if (activeTurnRef.current !== turn) return;
			if (result?.disposition === "handled") {
				const runtime = await client.state();
				if (activeTurnRef.current !== turn) return;
				// An input handler can consume the prompt or start its own turn.
				if (!chatRuntimeHasOpenTurn(runtime)) {
					dispatchConversationActions(turn.sessionId, [
						{ type: "local_user_queue_failed", clientMessageId },
						{ type: "local_turn_abort", timestampMs: Date.now() },
					]);
					releaseActiveTurn(turn);
					clearRecoveryState();
					return;
				}
			}
			turn.queueReady = true;
			flushBufferedQueuedMessages(turn);
			clearRecoveryState();
		},
		[
			clearRecoveryState,
			client,
			dispatchConversation,
			dispatchConversationActions,
			flushBufferedQueuedMessages,
			recoverSubmission,
			releaseActiveTurn,
			prepareRuntimeConfiguration,
			refreshSessionState,
			requestAutoTitle,
			runtimeListenerRef,
			session.temporary,
			t,
		],
	);

	const beginTurn = useCallback<BeginTurn>(
		async (
			submission,
			{
				appendUserMessage = true,
				preserveDraft = false,
				preserveScroll = false,
			} = {},
		) => {
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
						enabled: appendUserMessage && !preserveScroll,
					})
				: undefined;

			const turn: ActiveTurn = {
				sessionId: session.id,
				sessionTitle,
				projectId: session.projectRecord.id,
				notificationSessionId: session.id,
				generation: null,
				promptSent: false,
				runtimeStarted: false,
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
			cacheLocalChatImages(normalized.images);
			const conversationImages = summarizeChatImages(normalized.images);
			dispatchConversationActions(turn.sessionId, [
				{
					type: "local_user_submit",
					clientMessageId,
					text: trimmed,
					images: conversationImages,
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
			if (!preserveDraft) clearDraft();
			if (!preserveScroll) {
				requestAnimationFrame(() => scrollToBottom(false));
			}

			try {
				await runTurn(turn, normalized, clientMessageId);
			} catch (error) {
				if (
					projectMcpApprovalPendingRef.current &&
					activeTurnRef.current === turn &&
					!turn.promptSent
				) {
					pendingProjectMcpTurnRef.current = {
						turn,
						submission: normalized,
						clientMessageId,
					};
					return;
				}
				failActiveTurn(turn, runtimeErrorMessage(error));
			}
		},
		[
			activeTurnSessionIdRef,
			clearDraft,
			dispatchConversationActions,
			failActiveTurn,
			projectMcpApprovalPendingRef,
			runTurn,
			scrollRef,
			scrollToBottom,
			session.id,
			session.projectRecord.id,
			sessionTitle,
		],
	);

	const resumeProjectMcpTurn = useCallback(async () => {
		const pending = pendingProjectMcpTurnRef.current;
		pendingProjectMcpTurnRef.current = null;
		clearRecoveryState();
		if (!pending || activeTurnRef.current !== pending.turn) return;
		try {
			await runTurn(pending.turn, pending.submission, pending.clientMessageId);
		} catch (error) {
			failActiveTurn(pending.turn, runtimeErrorMessage(error));
			throw error;
		}
	}, [clearRecoveryState, failActiveTurn, runTurn]);

	const failProjectMcpTurn = useCallback(
		(error: unknown) => {
			const pending = pendingProjectMcpTurnRef.current;
			pendingProjectMcpTurnRef.current = null;
			clearRecoveryState();
			if (!pending || activeTurnRef.current !== pending.turn) return;
			failActiveTurn(pending.turn, runtimeErrorMessage(error));
		},
		[clearRecoveryState, failActiveTurn],
	);

	const cancelProjectMcpTurn = useCallback(() => {
		const pending = pendingProjectMcpTurnRef.current;
		pendingProjectMcpTurnRef.current = null;
		clearRecoveryState();
		if (!pending || activeTurnRef.current !== pending.turn) return;
		dispatchConversation(pending.turn.sessionId, {
			type: "local_turn_abort",
			timestampMs: Date.now(),
		});
		releaseActiveTurn(pending.turn);
	}, [clearRecoveryState, dispatchConversation, releaseActiveTurn]);

	useEffect(() => {
		beginTurnRef.current = beginTurn;
		return () => {
			if (beginTurnRef.current === beginTurn) beginTurnRef.current = null;
		};
	}, [beginTurn]);

	const handleSubmit = useCallback(
		(submission: ChatSubmission) => {
			void beginTurn(submission);
		},
		[beginTurn],
	);

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
			void beginTurn(initialSubmission, { appendUserMessage: false });
			for (const message of deferred) {
				queueMessage(createChatSubmission(message), "follow_up");
			}
			return;
		}

		const [first, ...rest] = deferred;
		if (!first) return;
		void beginTurn(createChatSubmission(first));
		for (const message of rest) {
			queueMessage(createChatSubmission(message), "follow_up");
		}
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
		pendingFollowUps,
		running: activeTurnSessionId === session.id,
		runtimeBusy:
			activeTurnSessionId !== null || recoveryState.status === "reconnecting",
		recoveryState,
		clearRecoveryState,
		resumeProjectMcpTurn,
		failProjectMcpTurn,
		cancelProjectMcpTurn,
		handleSubmit,
		handleSteer,
		handleFollowUp,
		handleEditQueued,
		handleSendQueuedNow,
		handleSendNow,
		handleStop,
	};
}
