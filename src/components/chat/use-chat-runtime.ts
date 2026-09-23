import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ChatSession } from "@/components/chat/chat-page-utils";
import type {
	ActiveTurn,
	BeginTurn,
	ChatSessionClient,
} from "@/components/chat/chat-runtime-types";
import {
	dispatchRuntimeEventToConversation,
	useChatRuntimeEvents,
} from "@/components/chat/use-chat-runtime-events";
import { useChatRuntimeQueue } from "@/components/chat/use-chat-runtime-queue";
import { createLocalMessageId } from "@/components/chat/use-chat-conversation";
import { useRuntimeConversationDispatch } from "@/components/chat/use-runtime-conversation-dispatch";
import { getReplyRunwayHeight } from "@/lib/chat-scroll-state";
import { registerChatRuntimeReplayTarget } from "@/lib/chat-runtime-replay";
import {
	chatSubmissionHasContent,
	createChatSubmission,
	summarizeChatImages,
	type ChatImageAttachment,
	type ChatSubmission,
} from "@/lib/chat-submission";
import { cacheLocalChatImages } from "@/lib/chat-image-media";
import type { ConversationAction } from "@/lib/conversation-types";
import { runtimeErrorMessage, type PiAgentState } from "@/lib/pi-runtime";
import { requestSessionTitle } from "@/lib/sessions";

export type { ChatRuntimeRecoveryState } from "@/components/chat/chat-runtime-types";

type UseChatRuntimeOptions = {
	active: boolean;
	session: ChatSession;
	sessionTitle: string;
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
	resetConversation: () => void;
	getActivePresentationIntervalMs: () => number;
	scrollRef: { current: HTMLDivElement | null };
	scrollToBottom: (smooth?: boolean) => void;
	clearDraft: () => void;
	restoreSubmission: (submission: ChatSubmission) => void;
	recoverSubmission: (submission: ChatSubmission) => void;
	prepareRuntimeConfiguration: (agentState: PiAgentState) => Promise<void>;
	refreshSessionState: () => Promise<void>;
	refreshSessionStats: () => Promise<void>;
};

export function useChatRuntime({
	active,
	session,
	sessionTitle,
	client,
	activeTurnSessionIdRef,
	initialMessage,
	initialImages = [],
	initialQueuedMessages = [],
	desktopNotifications,
	onSessionIdentified,
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
	const initialQueuedMessagesRef = useRef(initialQueuedMessages);
	const sentInitialPromptsRef = useRef(new Set<string>());
	const autoTitleRequestedRef = useRef(false);
	const beginTurnRef = useRef<BeginTurn | null>(null);
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
		pendingSteering,
		pendingFollowUps,
		setPendingQueueCounts,
		setPendingSteeringCount,
		acknowledgeQueuedMessage,
		releaseActiveTurn,
		flushBufferedQueuedMessages,
		queueMessage,
		handleSteer,
		handleFollowUp,
		handleEditQueued,
		handleSendQueuedNow,
		handleStop,
	} = useChatRuntimeQueue({
		session,
		client,
		activeTurnRef,
		activeTurnSessionIdRef,
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
		recoverRuntime,
		clearRecoveryState,
		failActiveTurn,
	} = useChatRuntimeEvents({
		session,
		sessionTitle,
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

	const beginTurn = useCallback<BeginTurn>(
		async (submission, appendUserMessage = true) => {
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
				sessionTitle,
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
			clearDraft();
			requestAnimationFrame(() => scrollToBottom(false));

			try {
				const subscription = runtimeListenerRef.current;
				if (!subscription) {
					throw new Error(t("errors.piEventChannel"));
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
				clearRecoveryState();
			} catch (error) {
				failActiveTurn(turn, runtimeErrorMessage(error));
			}
		},
		[
			activeTurnSessionIdRef,
			clearDraft,
			clearRecoveryState,
			client,
			dispatchConversationActions,
			failActiveTurn,
			flushBufferedQueuedMessages,
			prepareRuntimeConfiguration,
			requestAutoTitle,
			runtimeListenerRef,
			scrollRef,
			scrollToBottom,
			session.id,
			session.projectRecord.id,
			session.temporary,
			sessionTitle,
			t,
		],
	);

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
			void beginTurn(initialSubmission, false);
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
