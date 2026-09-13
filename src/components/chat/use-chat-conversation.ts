import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
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
import type { SessionHistory } from "@/lib/sessions";
import { loadSessionHistory } from "@/lib/sessions";
import {
	EMPTY_MESSAGES,
	MOCK_CONVERSATIONS,
} from "@/components/chat/chat-mock-conversations";
import {
	formatTime,
	getSessionHistoryFingerprint,
	type ChatSession,
} from "@/components/chat/chat-page-utils";

let localMessageSequence = 0;
let localActivitySequence = 0;

export function createLocalMessageId(kind: "user" | "assistant") {
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

type UseChatConversationOptions = {
	session: ChatSession;
	activeTurnSessionIdRef?: { current: string | null };
	initialMessage?: string;
	initialDraft?: string;
	loadState: "ready" | "loading" | "error";
	onDraftChange?: (value: string) => void;
	onHistoryMetadata: (history: SessionHistory) => void;
};

export function useChatConversation({
	session,
	activeTurnSessionIdRef,
	initialMessage,
	initialDraft = "",
	loadState,
	onDraftChange,
	onHistoryMetadata,
}: UseChatConversationOptions) {
	const [conversationStates, setConversationStates] = useState<
		Record<string, ConversationState>
	>({});
	const [historyLoadState, setHistoryLoadState] = useState<
		"ready" | "loading" | "error"
	>(session.sessionPath ? "loading" : "ready");
	const [historyRetry, setHistoryRetry] = useState(0);
	const [historyProgress, setHistoryProgress] = useState("");
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
		if (initialMessage) {
			return [
				{
					id: `${session.id}-initial`,
					role: "user",
					text: initialMessage,
					time: formatTime(),
				},
			];
		}
		if (session.sessionPath) return EMPTY_MESSAGES;
		return MOCK_CONVERSATIONS[session.id] ?? EMPTY_MESSAGES;
	}, [initialMessage, session.id, session.sessionPath]);
	const [draft, setDraftState] = useState(initialDraft);

	useEffect(() => {
		const sessionPath = session.sessionPath;
		if (!sessionPath) {
			loadedHistoryFingerprintRef.current = null;
			failedHistoryFingerprintRef.current = undefined;
			historyDeferredRef.current = false;
			return;
		}
		if (activeTurnSessionIdRef?.current === session.id) {
			historyDeferredRef.current = true;
			return;
		}
		historyDeferredRef.current = false;
		const requestedHistory = historyFingerprintRef.current;
		const requestedFingerprint = requestedHistory.fingerprint;
		let cancelled = false;
		const loadHistory = async (retryAttempt: number) => {
			const startedAt = performance.now();
			setHistoryLoadState("loading");
			setHistoryProgress("正在读取历史消息");
			try {
				const result = await loadSessionHistory(
					session.projectRecord.id,
					sessionPath,
					requestedHistory.fileSize !== undefined &&
						requestedHistory.fileMtimeNs !== undefined
						? {
								fileSize: requestedHistory.fileSize,
								fileMtimeNs: requestedHistory.fileMtimeNs,
							}
						: undefined,
				);
				if (cancelled) return;
				const history = result.history;
				console.info("[Pilo history] read_session_file", {
					durationMs: Math.round(performance.now() - startedAt),
					eventCount: history.events.length,
					retryAttempt,
				});
				onHistoryMetadata(history);
				const replayStartedAt = performance.now();
				setHistoryProgress("正在恢复历史消息");
				// Replay cooperatively so large JSONL histories do not monopolize the main
				// thread, but do not publish every partial state to React. Mounting Markdown
				// and re-measuring the virtual list after each 400-event batch was materially
				// slower than the reducer itself and made the loading skeleton linger.
				const finalState = await replayConversationEventsBatched(
					history.events,
					conversationReducerContext,
					{ maxEventsPerBatch: 400 },
				);
				if (cancelled) return;
				setConversationStates((current) => ({
					...current,
					[session.id]: finalState,
				}));
				console.info("[Pilo history] conversation_replay", {
					durationMs: Math.round(performance.now() - replayStartedAt),
					eventCount: history.events.length,
					messageCount: finalState.messages.length,
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
		historyRetry,
		onHistoryMetadata,
		session.id,
		session.projectRecord.id,
		session.sessionPath,
	]);

	const conversationState = conversationStates[session.id];
	const messages = conversationState?.messages ?? baseMessages;
	const pendingUsers = conversationState?.pendingUsers ?? [];
	const activeAssistantMessageId =
		conversationState?.active?.assistantMessageId ?? null;
	const messagesRef = useRef(messages);
	useLayoutEffect(() => {
		messagesRef.current = messages;
	}, [messages]);
	const effectiveLoadState = session.sessionPath
		? historyLoadState === "loading" && messages.length > 0
			? "ready"
			: historyLoadState
		: loadState;
	const setDraft = useCallback(
		(value: string) => {
			setDraftState(value);
			onDraftChange?.(value);
		},
		[onDraftChange],
	);
	const clearDraft = useCallback(() => setDraft(""), [setDraft]);
	const restoreDraftIfEmpty = useCallback(
		(value: string) => {
			setDraftState((current) => {
				if (current.trim()) return current;
				onDraftChange?.(value);
				return value;
			});
		},
		[onDraftChange],
	);

	const dispatchConversationBatch = useCallback(
		(targetSessionId: string, actions: readonly ConversationAction[]) => {
			if (actions.length === 0) return;
			setConversationStates((current) => {
				const existing =
					current[targetSessionId] ??
					createConversationState(
						targetSessionId === session.id ? messagesRef.current : [],
					);
				const next = reduceConversationActions(
					existing,
					actions,
					conversationReducerContext,
				);
				if (next === existing) return current;
				return { ...current, [targetSessionId]: next };
			});
		},
		[session.id],
	);
	const dispatchConversation = useCallback(
		(targetSessionId: string, action: ConversationAction) => {
			dispatchConversationBatch(targetSessionId, [action]);
		},
		[dispatchConversationBatch],
	);

	const refreshHistoryIfStale = useCallback(
		(active: boolean, activeTurnSessionId: string | null) => {
			if (!active || !session.sessionPath || historyLoadState === "loading") {
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
		baseMessages,
		messages,
		pendingUsers,
		activeAssistantMessageId,
		draft,
		setDraft,
		clearDraft,
		restoreDraftIfEmpty,
		dispatchConversation,
		dispatchConversationBatch,
		historyLoadState,
		historyProgress,
		effectiveLoadState,
		historyPending:
			session.sessionPath !== undefined && historyLoadState !== "ready",
		retryHistory: () => setHistoryRetry((value) => value + 1),
		refreshHistoryIfStale,
	};
}
