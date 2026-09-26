import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import type { ChatSessionRuntimeState } from "@/components/chat/chat-page-utils";
import { createChatHistoryWindowStore } from "@/components/chat/chat-history-window-store";
import {
	alignHistoryMessages,
	buildHistoryPrefix,
	HISTORY_PAGE_MESSAGE_COUNT,
	HISTORY_PREFETCH_MESSAGES,
	INITIAL_HISTORY_MESSAGE_COUNT,
	markExternalTurnLive,
	sameHistoryFingerprint,
} from "@/components/chat/chat-conversation-model";
import { createConversationState } from "@/lib/conversation-reducer";
import { replayConversationEvents } from "@/lib/conversation-replay";
import type { ConversationState } from "@/lib/conversation-types";
import type { PiAgentState } from "@/lib/pi-runtime";
import type {
	SessionHistoryFingerprint,
	SessionHistoryResult,
	SessionIndexEntry,
} from "@/lib/sessions";
import { reducerContext, sessionKey } from "./remote-app-model";
import type { WebPiloClient } from "./web-pilo-client";

type UseRemoteChatHistoryOptions = {
	client: WebPiloClient | null;
	activeProjectId: string;
	activeSessionKey: string | null;
	selectedSession: SessionIndexEntry | null;
	resyncKey: number;
	isExternalOpenTurn: (projectId: string, sessionPath: string) => boolean;
	refreshAgentConfig: () => Promise<void>;
	handleExpiredAuth: (error: unknown) => boolean;
	setFatalError: (message: string | null) => void;
	setConversation: Dispatch<SetStateAction<ConversationState>>;
	setRuntimeReady: Dispatch<SetStateAction<boolean>>;
	setReadOnly: Dispatch<SetStateAction<boolean>>;
	setAgentState: Dispatch<SetStateAction<PiAgentState | null>>;
	setChatState: Dispatch<SetStateAction<ChatSessionRuntimeState | null>>;
};

export function useRemoteChatHistory({
	client,
	activeProjectId,
	activeSessionKey,
	selectedSession,
	resyncKey,
	isExternalOpenTurn,
	refreshAgentConfig,
	handleExpiredAuth,
	setFatalError,
	setConversation,
	setRuntimeReady,
	setReadOnly,
	setAgentState,
	setChatState,
}: UseRemoteChatHistoryOptions) {
	const [historyStore] = useState(createChatHistoryWindowStore);
	const historySnapshot = useSyncExternalStore(
		historyStore.subscribe,
		historyStore.getSnapshot,
		historyStore.getSnapshot,
	);
	const historyPageRequestsRef = useRef(new Set<number>());
	const [historyFingerprint, setHistoryFingerprint] =
		useState<SessionHistoryFingerprint | null>(null);
	const [loadingConversation, setLoadingConversation] = useState(false);
	const [historyRetryKey, setHistoryRetryKey] = useState(0);

	const historyPrefix = useMemo(
		() => buildHistoryPrefix(historySnapshot),
		[historySnapshot],
	);

	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- Selecting a Host session or changing the resync generation intentionally replaces local replay state with the authoritative history snapshot. */
	useEffect(() => {
		void resyncKey;
		if (!client || !activeProjectId || !selectedSession) {
			if (!selectedSession) {
				setConversation(createConversationState());
				historyStore.initialize([], 0);
				historyPageRequestsRef.current.clear();
				setHistoryFingerprint(null);
				setRuntimeReady(false);
				setReadOnly(false);
				setAgentState(null);
				setChatState(null);
			}
			return;
		}
		let cancelled = false;
		setLoadingConversation(true);
		setRuntimeReady(false);
		const externalTurnOpen = isExternalOpenTurn(
			activeProjectId,
			selectedSession.sessionPath,
		);
		setReadOnly(externalTurnOpen);
		void client
			.loadHistory(activeProjectId, selectedSession.sessionPath, {
				messageLimit: INITIAL_HISTORY_MESSAGE_COUNT,
				includeMessageIndex: true,
			})
			.then((result: SessionHistoryResult) => {
				if (cancelled) return;
				const directory = result.history.messageIndex;
				const windowStart = result.history.windowStartMessage;
				if (!directory || windowStart === undefined) {
					throw new Error(
						"Session history window is missing its message index.",
					);
				}
				setHistoryFingerprint(result.fingerprint);
				historyPageRequestsRef.current.clear();
				historyStore.initialize(directory, windowStart);
				let state = replayConversationEvents(
					result.history.events,
					reducerContext,
				);
				state = alignHistoryMessages(state, directory, windowStart);
				if (externalTurnOpen) {
					state = markExternalTurnLive(state);
				}
				setConversation(state);
				return client.startChat({
					projectId: activeProjectId,
					sessionKey:
						activeSessionKey ??
						sessionKey(activeProjectId, selectedSession.piSessionId),
					sessionPath: selectedSession.sessionPath,
				});
			})
			.then(() => {
				if (cancelled) return;
				setRuntimeReady(true);
				void refreshAgentConfig();
			})
			.catch((error) => {
				if (cancelled || handleExpiredAuth(error)) return;
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("read-only observer mode")) {
					setReadOnly(true);
					return;
				}
				setFatalError(message);
			})
			.finally(() => {
				if (!cancelled) setLoadingConversation(false);
			});
		return () => {
			cancelled = true;
		};
	}, [
		activeProjectId,
		activeSessionKey,
		handleExpiredAuth,
		isExternalOpenTurn,
		refreshAgentConfig,
		resyncKey,
		historyRetryKey,
		selectedSession,
		client,
		historyStore,
		setAgentState,
		setChatState,
		setConversation,
		setFatalError,
		setReadOnly,
		setRuntimeReady,
	]);
	/* oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies */

	const requestHistoryRange = useCallback(
		(startIndex: number, endIndex: number) => {
			if (
				!client ||
				!activeProjectId ||
				!selectedSession ||
				!historyFingerprint
			) {
				return;
			}
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
				void client
					.loadHistory(activeProjectId, selectedSession.sessionPath, {
						startMessage: pageStart,
						messageLimit: pageEnd - pageStart + 1,
						includeMessageIndex: false,
						fingerprint: historyFingerprint,
					})
					.then((result) => {
						if (
							!sameHistoryFingerprint(historyFingerprint, result.fingerprint)
						) {
							setHistoryRetryKey((value) => value + 1);
							return;
						}
						let state = replayConversationEvents(
							result.history.events,
							reducerContext,
						);
						const actualStart = result.history.windowStartMessage ?? pageStart;
						state = alignHistoryMessages(
							state,
							historyStore.getSnapshot().directory,
							actualStart,
						);
						historyStore.hydrate(actualStart, state.messages);
					})
					.catch((error) => {
						if (!handleExpiredAuth(error)) {
							console.warn("Failed to hydrate remote history window", error);
						}
					})
					.finally(() => historyPageRequestsRef.current.delete(pageStart));
			}
		},
		[
			activeProjectId,
			client,
			handleExpiredAuth,
			historyFingerprint,
			historyStore,
			selectedSession,
		],
	);

	const retryHistory = useCallback(() => {
		setHistoryRetryKey((value) => value + 1);
	}, []);

	return {
		historyPrefix,
		fingerprint: historyFingerprint,
		loadingConversation,
		requestHistoryRange,
		retryHistory,
	};
}
