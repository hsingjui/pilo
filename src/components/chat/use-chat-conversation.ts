import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import {
	createConversationState,
	reduceConversationActions,
	replayConversationEventsBatched,
} from "@/lib/conversation-reducer";
import type {
	ChatMessage,
	ConversationAction,
	ConversationState,
} from "@/lib/conversation-types";
import {
	loadSessionHistoryWindow,
	type SessionHistory,
	type SessionHistoryFingerprint,
	type SessionHistoryMessageIndexEntry,
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
import {
	recordHistoryHydration,
	recordHistoryWindowLoad,
} from "@/lib/chat-performance";
import {
	createChatConversationStore,
	type ChatConversationStore,
} from "@/components/chat/chat-conversation-store";
import {
	createChatHistoryWindowStore,
	type ChatHistoryWindowStore,
} from "@/components/chat/chat-history-window-store";

let localMessageSequence = 0;
let localActivitySequence = 0;
const EMPTY_PENDING_USERS: ConversationState["pendingUsers"] = [];
const INITIAL_HISTORY_MESSAGE_COUNT = 80;
const HISTORY_PAGE_MESSAGE_COUNT = 48;
const HISTORY_PREFETCH_MESSAGES = 16;
const NOOP_EXTERNAL_STORE_SUBSCRIBE = () => () => undefined;

export function createLocalMessageId(
	kind: "user" | "assistant" | "compaction",
) {
	localMessageSequence += 1;
	return `local-${kind}-${Date.now()}-${localMessageSequence}`;
}

function createLocalContentId(kind: "thinking" | "text") {
	localActivitySequence += 1;
	return `local-${kind}-${Date.now()}-${localActivitySequence}`;
}

const conversationReducerContext = {
	createMessageId: createLocalMessageId,
	createContentId: createLocalContentId,
	now: () => Date.now(),
	formatTime,
};

function reviveExternalActivity<
	T extends {
		type: string;
		status?: "complete" | "running";
		result?: unknown;
	},
>(item: T): T {
	return item.type === "tool" && item.result === undefined
		? { ...item, status: "running" }
		: item;
}

function markExternalTurnLive(state: ConversationState): ConversationState {
	for (let index = state.messages.length - 1; index >= 0; index -= 1) {
		const message = state.messages[index];
		if (!message || message.role !== "assistant") continue;
		if (message.completion !== "interrupted") return state;
		const messages = state.messages.slice();
		messages[index] = {
			...message,
			content: message.content?.map(reviveExternalActivity),
			activity: message.activity?.map(reviveExternalActivity),
			streaming: true,
			completion: undefined,
			errorMessage: undefined,
		};
		return {
			...state,
			messages,
			active: {
				turnStartedAtMs: message.timestampMs,
				assistantUpdatedAtMs: message.timestampMs,
				assistantMessageId: message.id,
				firstRuntimeUserSeen: false,
			},
		};
	}
	return state;
}

function historyPlaceholderMessage(
	descriptor: SessionHistoryMessageIndexEntry,
): ChatMessage {
	const common = {
		id: descriptor.id,
		text: descriptor.preview,
		time:
			descriptor.timestampMs === undefined
				? ""
				: formatTime(descriptor.timestampMs),
		timestampMs: descriptor.timestampMs,
		historyPlaceholder: true as const,
		historyEstimatedChars: descriptor.estimatedChars,
	};
	if (descriptor.role === "user") return { ...common, role: "user" };
	if (descriptor.role === "compaction")
		return { ...common, role: "compaction" };
	return { ...common, role: "assistant" };
}

function alignHistoryMessages(
	state: ConversationState,
	directory: readonly SessionHistoryMessageIndexEntry[],
	startIndex: number,
): ConversationState {
	if (state.messages.length === 0) return state;
	let activeAssistantMessageId = state.active?.assistantMessageId;
	const messages = state.messages.map((message, offset) => {
		const descriptor = directory[startIndex + offset];
		if (!descriptor || descriptor.role !== message.role) return message;
		if (activeAssistantMessageId === message.id) {
			activeAssistantMessageId = descriptor.id;
		}
		return message.id === descriptor.id
			? message
			: { ...message, id: descriptor.id };
	});
	return {
		...state,
		messages,
		active: state.active
			? { ...state.active, assistantMessageId: activeAssistantMessageId }
			: null,
	};
}

function sameHistoryFingerprint(
	left: SessionHistoryFingerprint | null,
	right: SessionHistoryFingerprint | null,
) {
	return (
		left?.fileSize === right?.fileSize &&
		left?.fileMtimeNs === right?.fileMtimeNs
	);
}

function buildHistoryPrefix(
	snapshot: ReturnType<ChatHistoryWindowStore["getSnapshot"]>,
) {
	const messages: ChatMessage[] = [];
	for (let index = 0; index < snapshot.runtimeBaseStart; index += 1) {
		const descriptor = snapshot.directory[index];
		if (!descriptor) continue;
		messages.push(
			snapshot.hydrated.get(index) ?? historyPlaceholderMessage(descriptor),
		);
	}
	return messages;
}

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
	const historyPageRequestsRef = useRef(new Set<number>());
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
				if (cancelled) return;
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
				if (cancelled) return;
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
				if (cancelled) return;
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
				historyPageRequestsRef.current.add(pageStart);
				const windowStartedAt = performance.now();
				const loadedFingerprint = loadedWindowFingerprintRef.current;
				void loadSessionHistoryWindow(session.projectRecord.id, sessionPath, {
					startMessage: pageStart,
					messageLimit: pageEnd - pageStart + 1,
					fingerprint: loadedFingerprint ?? undefined,
				})
					.then(async (result) => {
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
					.catch((error) =>
						console.warn("Failed to hydrate history window", error),
					)
					.finally(() => {
						historyPageRequestsRef.current.delete(pageStart);
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

export function useChatConversationView({
	conversationStore,
	historyStore,
	baseMessages,
	sessionPath,
	historyLoadState,
	loadState,
	live = true,
}: {
	conversationStore: ChatConversationStore;
	historyStore: ChatHistoryWindowStore;
	baseMessages: ChatMessage[];
	sessionPath?: string;
	historyLoadState: "ready" | "loading" | "error";
	loadState: "ready" | "loading" | "error";
	live?: boolean;
}) {
	const frozenConversationRef = useRef(conversationStore.getSnapshot());
	const frozenHistoryRef = useRef(historyStore.getSnapshot());
	const frozenConversationSnapshot = useCallback(
		() => frozenConversationRef.current,
		[],
	);
	const frozenHistorySnapshot = useCallback(() => frozenHistoryRef.current, []);
	const conversationState = useSyncExternalStore(
		live ? conversationStore.subscribe : NOOP_EXTERNAL_STORE_SUBSCRIBE,
		live ? conversationStore.getSnapshot : frozenConversationSnapshot,
		live ? conversationStore.getSnapshot : frozenConversationSnapshot,
	);
	const historySnapshot = useSyncExternalStore(
		live ? historyStore.subscribe : NOOP_EXTERNAL_STORE_SUBSCRIBE,
		live ? historyStore.getSnapshot : frozenHistorySnapshot,
		live ? historyStore.getSnapshot : frozenHistorySnapshot,
	);
	useLayoutEffect(() => {
		if (!live) return;
		frozenConversationRef.current = conversationState;
		frozenHistoryRef.current = historySnapshot;
	}, [conversationState, historySnapshot, live]);
	const runtimeMessages = conversationState?.messages ?? baseMessages;
	useEffect(() => {
		recordHistoryHydration(
			historySnapshot.directory.length,
			historySnapshot.hydrated.size + runtimeMessages.length,
		);
	}, [historySnapshot, runtimeMessages.length]);
	// History changes only when its window/hydration state changes. Keep the
	// potentially large placeholder prefix stable while the runtime tail streams,
	// instead of rebuilding 0..runtimeBaseStart for every presentation flush.
	const historyPrefix = useMemo(
		() =>
			sessionPath && historySnapshot.directory.length > 0
				? buildHistoryPrefix(historySnapshot)
				: EMPTY_MESSAGES,
		[historySnapshot, sessionPath],
	);
	const messages = useMemo(
		() =>
			historyPrefix.length > 0
				? [...historyPrefix, ...runtimeMessages]
				: runtimeMessages,
		[historyPrefix, runtimeMessages],
	);
	const pendingUsers = conversationState?.pendingUsers ?? EMPTY_PENDING_USERS;
	const latestTurnInterrupted = useMemo(() => {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role === "assistant" && !message.historyPlaceholder) {
				return message.completion === "interrupted";
			}
		}
		return false;
	}, [messages]);
	const activeAssistantMessageId =
		conversationState?.active?.assistantMessageId ?? null;
	const effectiveLoadState = sessionPath
		? historyLoadState === "loading" && messages.length > 0
			? "ready"
			: historyLoadState
		: loadState;

	return {
		messages,
		pendingUsers,
		latestTurnInterrupted,
		activeAssistantMessageId,
		effectiveLoadState,
	};
}
