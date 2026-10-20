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
import { replayConversationEvents } from "@/lib/chat/conversation-replay";
import type { ConversationState } from "@/lib/chat/conversation-types";
import type {
	SessionHistory,
	SessionHistoryFingerprint,
	SessionHistoryResult,
	SessionIndexEntry,
} from "@/lib/api/sessions";
import { reducerContext, sessionKey } from "./remote-app-model";
import type { WebPiloClient } from "./web-pilo-client";

type UseRemoteChatHistoryOptions = {
	client: WebPiloClient | null;
	activeProjectId: string;
	activeSessionKey: string | null;
	selectedSession: SessionIndexEntry | null;
	resyncKey: number;
	isExternalOpenTurn: (projectId: string, sessionPath: string) => boolean;
	runtimeTurnOpen: boolean;
	refreshAgentConfig: (liveRuntime?: boolean) => Promise<void>;
	onHistoryMetadata: (history: SessionHistory) => void;
	handleExpiredAuth: (error: unknown) => boolean;
	setFatalError: (message: string | null) => void;
	setConversation: Dispatch<SetStateAction<ConversationState>>;
	getConversationState: () => ConversationState | undefined;
	setRuntimeReady: Dispatch<SetStateAction<boolean>>;
	setReadOnly: Dispatch<SetStateAction<boolean>>;
};

export function useRemoteChatHistory({
	client,
	activeProjectId,
	activeSessionKey,
	selectedSession,
	resyncKey,
	isExternalOpenTurn,
	runtimeTurnOpen,
	refreshAgentConfig,
	onHistoryMetadata,
	handleExpiredAuth,
	setFatalError,
	setConversation,
	getConversationState,
	setRuntimeReady,
	setReadOnly,
}: UseRemoteChatHistoryOptions) {
	const [historyStore] = useState(createChatHistoryWindowStore);
	const historySnapshot = useSyncExternalStore(
		historyStore.subscribe,
		historyStore.getSnapshot,
		historyStore.getSnapshot,
	);
	const historyPageRequestsRef = useRef(new Map<number, number>());
	const historyGenerationRef = useRef(0);
	const [historyFingerprint, setHistoryFingerprint] =
		useState<SessionHistoryFingerprint | null>(null);
	const [loadedIndexFingerprint, setLoadedIndexFingerprint] =
		useState<SessionHistoryFingerprint | null>(null);
	const [conversationLoad, setConversationLoad] = useState<{
		key: string | null;
		status: "ready" | "loading" | "error";
	}>({ key: null, status: "ready" });
	const [historyRetryKey, setHistoryRetryKey] = useState(0);
	const manualRefreshRef = useRef(false);
	const selectedSessionRef = useRef(selectedSession);
	useEffect(() => {
		selectedSessionRef.current = selectedSession;
	}, [selectedSession]);
	const selectedSessionPath = selectedSession?.sessionPath ?? null;
	const selectedSessionId = selectedSession?.piSessionId ?? null;
	const selectedLoadKey =
		activeProjectId && selectedSessionPath && selectedSessionId
			? `${activeProjectId}\u0000${selectedSessionId}\u0000${selectedSessionPath}`
			: null;
	const loadingConversation = Boolean(
		selectedLoadKey &&
		(conversationLoad.key !== selectedLoadKey ||
			conversationLoad.status === "loading"),
	);
	const externalTurnOpen = Boolean(
		selectedSessionPath &&
		isExternalOpenTurn(activeProjectId, selectedSessionPath),
	);
	const liveTurnOpen = externalTurnOpen || runtimeTurnOpen;
	const liveTurnOpenRef = useRef(liveTurnOpen);
	useEffect(() => {
		liveTurnOpenRef.current = liveTurnOpen;
	}, [liveTurnOpen]);

	const historyPrefix = useMemo(
		() => buildHistoryPrefix(historySnapshot),
		[historySnapshot],
	);

	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- Selecting a Host session or changing the resync generation intentionally replaces local replay state with the authoritative history snapshot. */
	// Clearing the selection (always via startDraft) only needs to drop the
	// history store here; conversation/runtime/agent state reset is owned by
	// startDraft. See use-remote-chat.ts for the rawSessions-drop fallback.
	useEffect(() => {
		if (selectedSessionPath) return;
		historyStore.initialize([], 0);
		historyPageRequestsRef.current.clear();
		setHistoryFingerprint(null);
		setConversationLoad({ key: null, status: "ready" });
	}, [historyStore, selectedSessionPath]);

	useEffect(() => {
		if (!selectedSessionPath) return;
		setReadOnly(externalTurnOpen);
	}, [externalTurnOpen, selectedSessionPath, setReadOnly]);

	useEffect(() => {
		if (
			!liveTurnOpen ||
			conversationLoad.key !== selectedLoadKey ||
			conversationLoad.status !== "ready"
		) {
			return;
		}
		setConversation((current) => markExternalTurnLive(current));
	}, [
		conversationLoad.key,
		conversationLoad.status,
		liveTurnOpen,
		selectedLoadKey,
		setConversation,
	]);

	useEffect(() => {
		const generation = ++historyGenerationRef.current;
		historyPageRequestsRef.current.clear();
		void resyncKey;
		if (
			!client ||
			!activeProjectId ||
			!selectedSessionPath ||
			!selectedSessionId ||
			!selectedLoadKey
		)
			return;
		const manualRefresh = manualRefreshRef.current;
		manualRefreshRef.current = false;
		if (
			manualRefresh &&
			(liveTurnOpenRef.current || getConversationState()?.active)
		)
			return;
		let cancelled = false;
		const requestedSession = selectedSessionRef.current;
		const requestedIndexFingerprint = requestedSession
			? {
					fileSize: requestedSession.fileSize,
					fileMtimeNs: requestedSession.fileMtimeNs,
				}
			: null;
		setConversationLoad({ key: selectedLoadKey, status: "loading" });
		setRuntimeReady(false);
		void client
			.loadHistory(activeProjectId, selectedSessionPath, {
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
				if (
					manualRefresh &&
					(liveTurnOpenRef.current || getConversationState()?.active)
				) {
					return client.chatState(
						activeSessionKey ?? sessionKey(activeProjectId, selectedSessionId),
					);
				}
				setHistoryFingerprint(result.fingerprint);
				setLoadedIndexFingerprint(requestedIndexFingerprint);
				historyPageRequestsRef.current.clear();
				historyStore.initialize(directory, windowStart);
				let state = replayConversationEvents(
					result.history.events,
					reducerContext,
				);
				state = alignHistoryMessages(state, directory, windowStart);
				// Restore the live tail before incoming events can create a new reply.
				if (liveTurnOpenRef.current) state = markExternalTurnLive(state);
				setConversation(state);
				onHistoryMetadata(result.history);
				if (result.history.headerMissing) return null;
				// The shared event stream already observes running sessions; viewing
				// history must not start a Pi process just to attach to an idle session.
				return client.chatState(
					activeSessionKey ?? sessionKey(activeProjectId, selectedSessionId),
				);
			})
			.then((runtime) => {
				if (cancelled) return;
				const ready = Boolean(
					runtime?.initialized && runtime.snapshot.state === "running",
				);
				setRuntimeReady(ready);
				setConversationLoad({ key: selectedLoadKey, status: "ready" });
				void refreshAgentConfig(ready);
			})
			.catch((error) => {
				if (cancelled || handleExpiredAuth(error)) return;
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("read-only observer mode")) {
					setReadOnly(true);
					setConversationLoad({ key: selectedLoadKey, status: "ready" });
					void refreshAgentConfig(false);
					return;
				}
				setConversationLoad({ key: selectedLoadKey, status: "error" });
				setFatalError(message);
			});
		return () => {
			cancelled = true;
			if (historyGenerationRef.current === generation) {
				historyGenerationRef.current += 1;
			}
		};
	}, [
		activeProjectId,
		activeSessionKey,
		handleExpiredAuth,
		getConversationState,
		refreshAgentConfig,
		onHistoryMetadata,
		resyncKey,
		historyRetryKey,
		selectedLoadKey,
		selectedSessionId,
		selectedSessionPath,
		client,
		historyStore,
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
				!selectedSessionPath ||
				!historyFingerprint ||
				conversationLoad.key !== selectedLoadKey ||
				conversationLoad.status !== "ready"
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
				const generation = historyGenerationRef.current;
				const isCurrent = () => historyGenerationRef.current === generation;
				historyPageRequestsRef.current.set(pageStart, generation);
				void client
					.loadHistory(activeProjectId, selectedSessionPath, {
						startMessage: pageStart,
						messageLimit: pageEnd - pageStart + 1,
						includeMessageIndex: false,
						fingerprint: historyFingerprint,
					})
					.then((result) => {
						if (!isCurrent()) return;
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
						if (!isCurrent()) return;
						if (!handleExpiredAuth(error)) {
							console.warn("Failed to hydrate remote history window", error);
						}
					})
					.finally(() => {
						if (historyPageRequestsRef.current.get(pageStart) === generation) {
							historyPageRequestsRef.current.delete(pageStart);
						}
					});
			}
		},
		[
			activeProjectId,
			client,
			conversationLoad,
			selectedLoadKey,
			handleExpiredAuth,
			historyFingerprint,
			historyStore,
			selectedSessionPath,
		],
	);

	const retryHistory = useCallback(() => {
		manualRefreshRef.current = true;
		setHistoryRetryKey((value) => value + 1);
	}, []);

	return {
		historyPrefix,
		fingerprint: historyFingerprint,
		loadingConversation,
		historyReady:
			!selectedLoadKey ||
			(conversationLoad.key === selectedLoadKey &&
				conversationLoad.status === "ready"),
		historyIndexStale: Boolean(
			!liveTurnOpen &&
			selectedSession &&
			conversationLoad.key === selectedLoadKey &&
			conversationLoad.status === "ready" &&
			historyFingerprint &&
			loadedIndexFingerprint &&
			sameHistoryFingerprint(loadedIndexFingerprint, {
				fileSize: selectedSession.fileSize,
				fileMtimeNs: selectedSession.fileMtimeNs,
			}) &&
			!sameHistoryFingerprint(historyFingerprint, loadedIndexFingerprint),
		),
		requestHistoryRange,
		retryHistory,
	};
}
