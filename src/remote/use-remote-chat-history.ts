import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useLayoutEffect,
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
	snapshotRefreshKey: number;
	historyCompletionKey: number;
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
	snapshotRefreshKey,
	historyCompletionKey,
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
	const conversationLoadKey = conversationLoad.key;
	const conversationLoadKeyRef = useRef(conversationLoadKey);
	useEffect(() => {
		conversationLoadKeyRef.current = conversationLoadKey;
	}, [conversationLoadKey]);
	const [historyRetryKey, setHistoryRetryKey] = useState(0);
	const deferredHistoryRefreshRef = useRef<string | null>(null);
	const manualRefreshRef = useRef(false);
	const reconciledCompletionRef = useRef(historyCompletionKey);
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
	/* oxlint-disable react/exhaustive-effect-dependencies -- Invalidate the old read at commit, before the next passive effect starts. */
	useLayoutEffect(() => {
		return () => {
			historyGenerationRef.current += 1;
		};
	}, [activeSessionKey, client, selectedLoadKey]);
	/* oxlint-enable react/exhaustive-effect-dependencies */
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
	const externalTurnOpenRef = useRef(externalTurnOpen);
	useEffect(() => {
		liveTurnOpenRef.current = liveTurnOpen;
		externalTurnOpenRef.current = externalTurnOpen;
	}, [externalTurnOpen, liveTurnOpen]);

	const historyPrefix = useMemo(
		() =>
			selectedLoadKey &&
			conversationLoad.key === selectedLoadKey &&
			conversationLoad.status === "ready"
				? buildHistoryPrefix(historySnapshot)
				: [],
		[
			conversationLoad.key,
			conversationLoad.status,
			historySnapshot,
			selectedLoadKey,
		],
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
		if (
			!selectedLoadKey ||
			conversationLoad.key !== selectedLoadKey ||
			conversationLoad.status === "loading" ||
			liveTurnOpen ||
			(reconciledCompletionRef.current === historyCompletionKey &&
				deferredHistoryRefreshRef.current !== selectedLoadKey)
		) {
			return;
		}
		reconciledCompletionRef.current = historyCompletionKey;
		deferredHistoryRefreshRef.current = null;
		setHistoryRetryKey((value) => value + 1);
	}, [conversationLoad, historyCompletionKey, liveTurnOpen, selectedLoadKey]);

	useEffect(() => {
		const generation = ++historyGenerationRef.current;
		historyPageRequestsRef.current.clear();
		void resyncKey;
		void snapshotRefreshKey;
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
		const isCurrent = () => historyGenerationRef.current === generation;
		const refreshing = conversationLoadKeyRef.current === selectedLoadKey;
		const initialState = getConversationState();
		const requestedSession = selectedSessionRef.current;
		const requestedIndexFingerprint = requestedSession
			? {
					fileSize: requestedSession.fileSize,
					fileMtimeNs: requestedSession.fileMtimeNs,
				}
			: null;
		if (!refreshing) {
			historyStore.initialize([], 0);
			setHistoryFingerprint(null);
			setLoadedIndexFingerprint(null);
			setConversationLoad({ key: selectedLoadKey, status: "loading" });
			setRuntimeReady(false);
		}
		const targetKey =
			activeSessionKey ?? sessionKey(activeProjectId, selectedSessionId);
		void client
			.loadHistory(activeProjectId, selectedSessionPath, {
				messageLimit: INITIAL_HISTORY_MESSAGE_COUNT,
				includeMessageIndex: true,
			})
			.then(async (result: SessionHistoryResult) => {
				if (!isCurrent()) return null;
				const runtime = result.history.headerMissing
					? null
					: await client.chatState(targetKey);
				const live =
					externalTurnOpenRef.current ||
					Boolean(runtime?.activeTurn || runtime?.compacting);
				if (!isCurrent()) return;
				const directory = result.history.messageIndex;
				const windowStart = result.history.windowStartMessage;
				if (!directory || windowStart === undefined) {
					throw new Error(
						"Session history window is missing its message index.",
					);
				}
				const current = getConversationState();
				if (
					current !== initialState ||
					(live && (manualRefresh || current?.active))
				) {
					if (!manualRefresh) {
						if (live) deferredHistoryRefreshRef.current = selectedLoadKey;
						else setHistoryRetryKey((value) => value + 1);
					}
					return runtime;
				}
				deferredHistoryRefreshRef.current = null;
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
				if (live) state = markExternalTurnLive(state);
				setConversation(
					live && current?.pendingUsers.length
						? { ...state, pendingUsers: current.pendingUsers }
						: state,
				);
				onHistoryMetadata(result.history);
				return runtime;
			})
			.then((runtime) => {
				if (!isCurrent()) return;
				const ready = Boolean(
					runtime?.initialized && runtime.snapshot.state === "running",
				);
				setRuntimeReady(ready);
				setConversationLoad((current) =>
					current.key === selectedLoadKey && current.status === "ready"
						? current
						: { key: selectedLoadKey, status: "ready" },
				);
				void refreshAgentConfig(ready);
			})
			.catch((error) => {
				if (!isCurrent() || handleExpiredAuth(error)) return;
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
		snapshotRefreshKey,
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
