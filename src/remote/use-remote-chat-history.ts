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
import type { AssistantContentItem } from "@/lib/chat/chat-activity-state";
import { replayConversationEvents } from "@/lib/chat/conversation-replay";
import type {
	ChatMessage,
	ConversationState,
} from "@/lib/chat/conversation-types";
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

function sameAssistant(
	saved: ChatMessage | undefined,
	live: ChatMessage | undefined,
): boolean {
	if (saved?.role !== "assistant" || live?.role !== "assistant") return false;
	return (
		saved.id === live.id ||
		(saved.content?.some(
			(item) =>
				item.type === "tool" &&
				live.content?.some(
					(other) => other.type === "tool" && other.id === item.id,
				),
		) ??
			false)
	);
}

function mergeAssistantContent(
	saved: readonly AssistantContentItem[],
	live: readonly AssistantContentItem[],
): AssistantContentItem[] {
	const content: AssistantContentItem[] = [];
	let savedStart = 0;
	let liveStart = 0;
	// Shared tools anchor the two ordered streams without dropping earlier content.
	const appendSpan = (savedEnd: number, liveEnd: number) => {
		const before = saved.slice(savedStart, savedEnd);
		const after = live.slice(liveStart, liveEnd);
		const tail = before.at(-1);
		const head = after[0];
		if (
			tail &&
			head &&
			tail.type !== "tool" &&
			head.type === tail.type &&
			(tail.text.startsWith(head.text) || head.text.startsWith(tail.text))
		) {
			if (tail.text.length > head.text.length)
				after[0] = { ...head, text: tail.text };
			before.pop();
		}
		content.push(...before, ...after);
	};
	for (let index = 0; index < live.length; index += 1) {
		const item = live[index];
		if (item.type !== "tool") continue;
		const savedIndex = saved.findIndex(
			(other, offset) =>
				offset >= savedStart && other.type === "tool" && other.id === item.id,
		);
		const earlier = saved[savedIndex];
		if (earlier?.type !== "tool") continue;
		appendSpan(savedIndex, index);
		content.push({
			...earlier,
			...item,
			args: item.args ?? earlier.args,
			result: item.result ?? earlier.result,
			...(earlier.result !== undefined &&
				item.status === "running" && {
					status: earlier.status,
					result: earlier.result,
					isError: earlier.isError,
				}),
		});
		savedStart = savedIndex + 1;
		liveStart = index + 1;
	}
	appendSpan(saved.length, live.length);
	return content;
}

function mergeInitialHistory(
	history: ConversationState,
	current: ConversationState,
): ConversationState {
	const { messages } = history;
	const pendingUserIds = new Set(
		current.pendingUsers.map((user) => user.clientMessageId),
	);
	// A JSONL snapshot can include the beginning of the suffix already seen live.
	// Compare only the loaded window, never the paged history or each delta.
	let overlap = Math.min(messages.length, current.messages.length);
	findOverlap: for (; overlap > 0; overlap -= 1) {
		const start = messages.length - overlap;
		for (let index = 0; index < overlap; index += 1) {
			const message = current.messages[index];
			const saved = messages[start + index];
			if (saved.role !== message.role || pendingUserIds.has(message.id))
				continue findOverlap;
			if (saved.role === "assistant") {
				if (!sameAssistant(saved, message)) continue findOverlap;
			} else if (
				saved.id !== message.id &&
				!(
					saved.role === "user" &&
					saved.text === message.text &&
					index + 1 < overlap &&
					sameAssistant(
						messages[start + index + 1],
						current.messages[index + 1],
					)
				)
			) {
				// Text and streaming flags alone cannot distinguish repeated turns.
				continue findOverlap;
			}
		}
		break;
	}
	const prefixLength = messages.length - overlap;
	return {
		...current,
		messages: [
			...messages.slice(0, prefixLength),
			...current.messages.slice(0, overlap).map((message, index) => {
				const saved = messages[prefixLength + index];
				if (saved.role === "user" && message.role === "user" && saved.images)
					return { ...message, images: saved.images };
				if (
					saved.role !== "assistant" ||
					message.role !== "assistant" ||
					!saved.content?.length
				)
					return message;
				const content = mergeAssistantContent(
					saved.content,
					message.content ?? [],
				);
				const text = content
					.map((item) => (item.type === "text" ? item.text : ""))
					.join("");
				return {
					...message,
					content,
					text: text || message.text || saved.text,
				};
			}),
			...current.messages.slice(overlap),
		],
		pendingUsers: prefixLength
			? current.pendingUsers.map((user) =>
					user.replyStartIndex === undefined
						? user
						: { ...user, replyStartIndex: user.replyStartIndex + prefixLength },
				)
			: current.pendingUsers,
	};
}

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
	const appliedHistoryKeyRef = useRef<string | null>(null);
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
		appliedHistoryKeyRef.current = null;
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
			appliedHistoryKeyRef.current = null;
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
				const hasHistory = appliedHistoryKeyRef.current === selectedLoadKey;
				if (
					(hasHistory || manualRefresh) &&
					(current !== initialState ||
						(live && (manualRefresh || current?.active)))
				) {
					if (!manualRefresh) {
						if (live) deferredHistoryRefreshRef.current = selectedLoadKey;
						else setHistoryRetryKey((value) => value + 1);
					}
					return runtime;
				}
				const mergeLive =
					!hasHistory &&
					!manualRefresh &&
					current &&
					(live || current !== initialState || current.active !== null) &&
					(current.messages.length > 0 || current.pendingUsers.length > 0);
				appliedHistoryKeyRef.current = selectedLoadKey;
				// Runtime messages don't carry JSONL entry IDs; reconcile the seam once idle.
				deferredHistoryRefreshRef.current = mergeLive ? selectedLoadKey : null;
				setHistoryFingerprint(result.fingerprint);
				setLoadedIndexFingerprint(requestedIndexFingerprint);
				historyPageRequestsRef.current.clear();
				historyStore.initialize(directory, windowStart);
				let state = replayConversationEvents(
					result.history.events,
					reducerContext,
				);
				state = alignHistoryMessages(state, directory, windowStart);
				if (mergeLive) {
					state = mergeInitialHistory(state, current);
				} else {
					// Restore the live tail before incoming events can create a new reply.
					if (live) state = markExternalTurnLive(state);
					if (live && current?.pendingUsers.length)
						state = { ...state, pendingUsers: current.pendingUsers };
				}
				setConversation(state);
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
