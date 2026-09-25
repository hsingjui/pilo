import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createConversationState } from "@/lib/conversation-reducer";
import {
	reduceConversationActions,
	replayConversationEventsBatched,
} from "@/lib/conversation-replay";
import type { ChatMessage, ConversationAction } from "@/lib/conversation-types";
import {
	loadSessionHistoryWindow,
	type SessionHistory,
	type SessionHistoryFingerprint,
} from "@/lib/sessions";
import {
	summarizeChatImages,
	type ChatImageAttachment,
} from "@/lib/chat-submission";
import {
	EMPTY_MESSAGES,
	MOCK_CONVERSATIONS,
} from "@/components/chat/chat-mock-conversations";
import {
	formatTime,
	getSessionHistoryFingerprint,
	type ChatSession,
} from "@/components/chat/chat-page-utils";
import { recordHistoryWindowLoad } from "@/lib/chat-performance";
import {
	alignHistoryMessages,
	buildHistoryPrefix,
	conversationReducerContext,
	markExternalTurnLive,
	sameHistoryFingerprint,
} from "@/components/chat/chat-conversation-model";
import { createChatConversationStore } from "@/components/chat/chat-conversation-store";
import { createChatHistoryWindowStore } from "@/components/chat/chat-history-window-store";

const INITIAL_HISTORY_MESSAGE_COUNT = 80;
const HISTORY_PAGE_MESSAGE_COUNT = 48;
const HISTORY_PREFETCH_MESSAGES = 16;

type UseChatConversationOptions = {
	session: ChatSession;
	activeTurnSessionIdRef?: { current: string | null };
	initialMessage?: string;
	initialImages?: readonly ChatImageAttachment[];
	initialDraft?: string;
	onDraftChange?: (value: string) => void;
	onHistoryMetadata: (history: SessionHistory) => void;
};

export function useChatConversation({
	session,
	activeTurnSessionIdRef,
	initialMessage,
	initialImages = [],
	initialDraft = "",
	onDraftChange,
	onHistoryMetadata,
}: UseChatConversationOptions) {
	const [conversationStore] = useState(createChatConversationStore);
	const [historyStore] = useState(createChatHistoryWindowStore);
	const historyRequestGenerationRef = useRef(0);
	const historyPageRequestsRef = useRef(new Map<number, number>());
	const loadedWindowFingerprintRef = useRef<SessionHistoryFingerprint | null>(
		null,
	);
	const historyReloadScheduledRef = useRef(false);
	const [historyLoadState, setHistoryLoadState] = useState<
		"ready" | "loading" | "error"
	>(session.sessionPath ? "loading" : "ready");
	const [historyRetry, setHistoryRetry] = useState(0);
	const [historyProgress, setHistoryProgress] = useState<
		"" | "chat.historyLoading" | "chat.historyRestoring"
	>("");
	const [historyImageFingerprint, setHistoryImageFingerprint] =
		useState<SessionHistoryFingerprint | null>(null);
	const sessionHistoryFingerprint = getSessionHistoryFingerprint(session);
	const historyFingerprintRef = useRef({
		fingerprint: sessionHistoryFingerprint,
		fileSize: session.historyFileSize,
		fileMtimeNs: session.historyFileMtimeNs,
	});
	useEffect(() => {
		historyFingerprintRef.current = {
			fingerprint: sessionHistoryFingerprint,
			fileSize: session.historyFileSize,
			fileMtimeNs: session.historyFileMtimeNs,
		};
	}, [
		session.historyFileMtimeNs,
		session.historyFileSize,
		sessionHistoryFingerprint,
	]);
	const loadedHistoryFingerprintRef = useRef<string | null>(null);
	const failedHistoryFingerprintRef = useRef<string | null | undefined>(
		undefined,
	);
	const historyDeferredRef = useRef(false);
	const baseMessages = useMemo<ChatMessage[]>(() => {
		if (initialMessage || initialImages.length > 0) {
			return [
				{
					id: `${session.id}-initial`,
					role: "user",
					text: initialMessage ?? "",
					images: summarizeChatImages(initialImages),
					time: formatTime(),
				},
			];
		}
		if (session.sessionPath) return EMPTY_MESSAGES;
		return MOCK_CONVERSATIONS[session.id] ?? EMPTY_MESSAGES;
	}, [initialImages, initialMessage, session.id, session.sessionPath]);
	const [draft, setDraftState] = useState(initialDraft);

	useEffect(() => {
		const requestGeneration = ++historyRequestGenerationRef.current;
		const sessionPath = session.sessionPath;
		if (!sessionPath) {
			loadedHistoryFingerprintRef.current = null;
			loadedWindowFingerprintRef.current = null;
			failedHistoryFingerprintRef.current = undefined;
			historyDeferredRef.current = false;
			historyPageRequestsRef.current.clear();
			historyReloadScheduledRef.current = false;
			historyStore.initialize([], 0);
			return;
		}
		if (activeTurnSessionIdRef?.current === session.id) {
			historyDeferredRef.current = true;
			return;
		}
		historyDeferredRef.current = false;
		const requestedHistory = historyFingerprintRef.current;
		const requestedFingerprint = requestedHistory.fingerprint;
		const requestFingerprint =
			requestedHistory.fileSize !== undefined &&
			requestedHistory.fileMtimeNs !== undefined
				? {
						fileSize: requestedHistory.fileSize,
						fileMtimeNs: requestedHistory.fileMtimeNs,
					}
				: undefined;
		let cancelled = false;
		const loadHistory = async (retryAttempt: number) => {
			const startedAt = performance.now();
			setHistoryLoadState("loading");
			setHistoryProgress("chat.historyLoading");
			try {
				const result = await loadSessionHistoryWindow(
					session.projectRecord.id,
					sessionPath,
					{
						messageLimit: INITIAL_HISTORY_MESSAGE_COUNT,
						includeMessageIndex: true,
						fingerprint: requestFingerprint,
					},
				);
				if (
					cancelled ||
					historyRequestGenerationRef.current !== requestGeneration
				) {
					return;
				}
				const history = result.history;
				const directory = history.messageIndex;
				const windowStart = history.windowStartMessage;
				if (!directory || windowStart === undefined) {
					throw new Error(
						"Session history window is missing its message index.",
					);
				}
				console.info("[Pilo history] read_session_window", {
					durationMs: Math.round(performance.now() - startedAt),
					eventCount: history.events.length,
					windowStart,
					windowMessageCount: history.windowMessageCount,
					totalMessages: history.totalMessages,
					retryAttempt,
				});
				onHistoryMetadata(history);
				const replayStartedAt = performance.now();
				setHistoryProgress("chat.historyRestoring");
				let finalState = await replayConversationEventsBatched(
					history.events,
					conversationReducerContext,
					{ maxEventsPerBatch: 400 },
				);
				if (
					cancelled ||
					historyRequestGenerationRef.current !== requestGeneration
				) {
					return;
				}
				finalState = alignHistoryMessages(finalState, directory, windowStart);
				if (session.externalRunning && session.externalTurnOpen) {
					finalState = markExternalTurnLive(finalState);
				}
				historyStore.initialize(directory, windowStart);
				conversationStore.setSnapshot(finalState);
				recordHistoryWindowLoad({
					durationMs: performance.now() - startedAt,
					messageCount: finalState.messages.length,
					directoryMessages: directory.length,
					hydratedMessages: finalState.messages.length,
				});
				loadedWindowFingerprintRef.current = result.fingerprint;
				setHistoryImageFingerprint(result.fingerprint);
				historyPageRequestsRef.current.clear();
				historyReloadScheduledRef.current = false;
				console.info("[Pilo history] conversation_window_replay", {
					durationMs: Math.round(performance.now() - replayStartedAt),
					eventCount: history.events.length,
					messageCount: finalState.messages.length,
					totalMessages: directory.length,
				});
				loadedHistoryFingerprintRef.current = result.fingerprint
					? `${result.fingerprint.fileSize}:${result.fingerprint.fileMtimeNs}`
					: requestedFingerprint;
				failedHistoryFingerprintRef.current = undefined;
				setHistoryProgress("");
				setHistoryLoadState("ready");
			} catch (error) {
				if (
					cancelled ||
					historyRequestGenerationRef.current !== requestGeneration
				) {
					return;
				}
				console.error("Failed to read session history", error);
				failedHistoryFingerprintRef.current = requestedFingerprint;
				setHistoryProgress("");
				setHistoryLoadState("error");
			}
		};
		void loadHistory(historyRetry);
		return () => {
			cancelled = true;
		};
	}, [
		activeTurnSessionIdRef,
		conversationStore,
		historyRetry,
		historyStore,
		onHistoryMetadata,
		session.externalRunning,
		session.externalTurnOpen,
		session.id,
		session.projectRecord.id,
		session.sessionPath,
	]);

	const setDraft = useCallback(
		(value: string) => {
			setDraftState(value);
			onDraftChange?.(value);
		},
		[onDraftChange],
	);
	const clearDraft = useCallback(() => setDraft(""), [setDraft]);

	const dispatchConversationBatch = useCallback(
		(targetSessionId: string, actions: readonly ConversationAction[]) => {
			if (actions.length === 0 || targetSessionId !== session.id) return;
			const existing =
				conversationStore.getSnapshot() ??
				createConversationState(baseMessages);
			const next = reduceConversationActions(
				existing,
				actions,
				conversationReducerContext,
			);
			if (next !== existing) conversationStore.setSnapshot(next);
		},
		[baseMessages, conversationStore, session.id],
	);
	const dispatchConversation = useCallback(
		(targetSessionId: string, action: ConversationAction) => {
			dispatchConversationBatch(targetSessionId, [action]);
		},
		[dispatchConversationBatch],
	);

	const getConversationMessages = useCallback(() => {
		const runtimeMessages =
			conversationStore.getSnapshot()?.messages ?? baseMessages;
		const historySnapshot = historyStore.getSnapshot();
		if (!session.sessionPath || historySnapshot.directory.length === 0) {
			return runtimeMessages;
		}
		return [...buildHistoryPrefix(historySnapshot), ...runtimeMessages];
	}, [baseMessages, conversationStore, historyStore, session.sessionPath]);

	const requestHistoryRange = useCallback(
		(startIndex: number, endIndex: number) => {
			const sessionPath = session.sessionPath;
			if (!sessionPath || historyLoadState !== "ready") return;
			const snapshot = historyStore.getSnapshot();
			if (snapshot.runtimeBaseStart <= 0) return;

			const prefetchStart = Math.max(0, startIndex - HISTORY_PREFETCH_MESSAGES);
			const prefetchEnd = Math.min(
				snapshot.runtimeBaseStart - 1,
				endIndex + HISTORY_PREFETCH_MESSAGES,
			);
			historyStore.setPinnedRange(prefetchStart, prefetchEnd);
			if (prefetchEnd < prefetchStart) return;

			const firstPage =
				Math.floor(prefetchStart / HISTORY_PAGE_MESSAGE_COUNT) *
				HISTORY_PAGE_MESSAGE_COUNT;
			const lastPage =
				Math.floor(prefetchEnd / HISTORY_PAGE_MESSAGE_COUNT) *
				HISTORY_PAGE_MESSAGE_COUNT;
			for (
				let pageStart = firstPage;
				pageStart <= lastPage;
				pageStart += HISTORY_PAGE_MESSAGE_COUNT
			) {
				const pageEnd = Math.min(
					snapshot.runtimeBaseStart - 1,
					pageStart + HISTORY_PAGE_MESSAGE_COUNT - 1,
				);
				if (
					historyStore.isRangeHydrated(pageStart, pageEnd) ||
					historyPageRequestsRef.current.has(pageStart)
				) {
					continue;
				}
				const requestGeneration = historyRequestGenerationRef.current;
				historyPageRequestsRef.current.set(pageStart, requestGeneration);
				const windowStartedAt = performance.now();
				const loadedFingerprint = loadedWindowFingerprintRef.current;
				const requestIsCurrent = () =>
					historyRequestGenerationRef.current === requestGeneration &&
					sameHistoryFingerprint(
						loadedFingerprint,
						loadedWindowFingerprintRef.current,
					);
				void loadSessionHistoryWindow(session.projectRecord.id, sessionPath, {
					startMessage: pageStart,
					messageLimit: pageEnd - pageStart + 1,
					fingerprint: loadedFingerprint ?? undefined,
				})
					.then(async (result) => {
						if (!requestIsCurrent()) return;
						if (
							!sameHistoryFingerprint(loadedFingerprint, result.fingerprint)
						) {
							if (!historyReloadScheduledRef.current) {
								historyReloadScheduledRef.current = true;
								setHistoryRetry((value) => value + 1);
							}
							return;
						}
						const history = result.history;
						const actualStart = history.windowStartMessage ?? pageStart;
						let state = await replayConversationEventsBatched(
							history.events,
							conversationReducerContext,
							{ maxEventsPerBatch: 400 },
						);
						if (!requestIsCurrent()) return;
						const currentDirectory = historyStore.getSnapshot().directory;
						state = alignHistoryMessages(state, currentDirectory, actualStart);
						historyStore.hydrate(actualStart, state.messages);
						const hydratedSnapshot = historyStore.getSnapshot();
						const runtimeMessageCount =
							conversationStore.getSnapshot()?.messages.length ?? 0;
						recordHistoryWindowLoad({
							durationMs: performance.now() - windowStartedAt,
							messageCount: state.messages.length,
							directoryMessages: hydratedSnapshot.directory.length,
							hydratedMessages:
								hydratedSnapshot.hydrated.size + runtimeMessageCount,
						});
					})
					.catch((error) => {
						if (!requestIsCurrent()) return;
						console.warn("Failed to hydrate history window", error);
					})
					.finally(() => {
						if (
							historyPageRequestsRef.current.get(pageStart) ===
							requestGeneration
						) {
							historyPageRequestsRef.current.delete(pageStart);
						}
					});
			}
		},
		[
			conversationStore,
			historyLoadState,
			historyStore,
			session.projectRecord.id,
			session.sessionPath,
		],
	);

	const refreshHistoryIfStale = useCallback(
		(isActive: boolean, activeTurnSessionId: string | null) => {
			if (!isActive || !session.sessionPath || historyLoadState === "loading") {
				return;
			}
			if (activeTurnSessionId === session.id) return;
			if (historyDeferredRef.current) {
				historyDeferredRef.current = false;
				setHistoryRetry((value) => value + 1);
				return;
			}
			if (sessionHistoryFingerprint === null) return;
			const loadedFingerprint = loadedHistoryFingerprintRef.current;
			if (loadedFingerprint === sessionHistoryFingerprint) return;
			if (
				loadedFingerprint === null &&
				(historyLoadState !== "error" ||
					failedHistoryFingerprintRef.current === sessionHistoryFingerprint)
			) {
				return;
			}
			setHistoryRetry((value) => value + 1);
		},
		[
			historyLoadState,
			session.id,
			session.sessionPath,
			sessionHistoryFingerprint,
		],
	);

	return {
		conversationStore,
		historyStore,
		baseMessages,
		draft,
		setDraft,
		clearDraft,
		dispatchConversation,
		dispatchConversationBatch,
		getConversationMessages,
		requestHistoryRange,
		historyLoadState,
		historyProgress,
		historyImageFingerprint,
		historyPending:
			session.sessionPath !== undefined && historyLoadState !== "ready",
		retryHistory: () => setHistoryRetry((value) => value + 1),
		refreshHistoryIfStale,
	};
}
