import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";

import type { ChatConversationStore } from "@/components/chat/chat-conversation-store";
import { buildHistoryPrefix } from "@/components/chat/chat-conversation-model";
import type { ChatHistoryWindowStore } from "@/components/chat/chat-history-window-store";
import { EMPTY_MESSAGES } from "@/components/chat/chat-mock-conversations";
import { recordHistoryHydration } from "@/lib/chat/chat-performance";
import type {
	ChatMessage,
	ConversationState,
} from "@/lib/chat/conversation-types";

const EMPTY_PENDING_USERS: ConversationState["pendingUsers"] = [];
const NOOP_EXTERNAL_STORE_SUBSCRIBE = () => () => undefined;

export function useChatConversationView({
	conversationStore,
	historyStore,
	baseMessages,
	sessionPath,
	historyLoadState,
	loadState,
	findOpen,
	live = true,
}: {
	conversationStore: ChatConversationStore;
	historyStore: ChatHistoryWindowStore;
	baseMessages: ChatMessage[];
	sessionPath?: string;
	historyLoadState: "ready" | "loading" | "error";
	loadState: "ready" | "loading" | "error";
	findOpen: boolean;
	live?: boolean;
}) {
	const frozenTimelineRef = useRef(conversationStore.getTimelineSnapshot());
	const frozenSearchRef = useRef<ConversationState | undefined>(undefined);
	const frozenHistoryRef = useRef(historyStore.getSnapshot());
	const frozenTimelineSnapshot = useCallback(
		() => frozenTimelineRef.current,
		[],
	);
	const frozenSearchSnapshot = useCallback(() => frozenSearchRef.current, []);
	const frozenHistorySnapshot = useCallback(() => frozenHistoryRef.current, []);
	const getTimeline = live
		? conversationStore.getTimelineSnapshot
		: frozenTimelineSnapshot;
	const timeline = useSyncExternalStore(
		live ? conversationStore.subscribe : NOOP_EXTERNAL_STORE_SUBSCRIBE,
		getTimeline,
		getTimeline,
	);
	const searchLive = live && findOpen;
	const getSearch = searchLive
		? conversationStore.getSnapshot
		: frozenSearchSnapshot;
	const search = useSyncExternalStore(
		searchLive ? conversationStore.subscribe : NOOP_EXTERNAL_STORE_SUBSCRIBE,
		getSearch,
		getSearch,
	);
	const historySnapshot = useSyncExternalStore(
		live ? historyStore.subscribe : NOOP_EXTERNAL_STORE_SUBSCRIBE,
		live ? historyStore.getSnapshot : frozenHistorySnapshot,
		live ? historyStore.getSnapshot : frozenHistorySnapshot,
	);
	useLayoutEffect(() => {
		if (!live) return;
		frozenTimelineRef.current = timeline;
		frozenSearchRef.current = findOpen ? search : undefined;
		frozenHistoryRef.current = historySnapshot;
	}, [findOpen, historySnapshot, live, search, timeline]);
	const runtimeMessages = timeline?.messages ?? baseMessages;
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
	const searchRuntimeMessages = findOpen ? search?.messages : undefined;
	const searchMessages = useMemo(
		() =>
			searchRuntimeMessages && searchRuntimeMessages !== runtimeMessages
				? historyPrefix.length > 0
					? [...historyPrefix, ...searchRuntimeMessages]
					: searchRuntimeMessages
				: messages,
		[historyPrefix, messages, runtimeMessages, searchRuntimeMessages],
	);
	const pendingUsers = timeline?.pendingUsers ?? EMPTY_PENDING_USERS;
	const latestTurnInterrupted = useMemo(() => {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role === "assistant" && !message.historyPlaceholder) {
				return message.completion === "interrupted";
			}
		}
		return false;
	}, [messages]);
	const activeAssistantMessageId = timeline?.activeAssistantMessageId ?? null;
	const effectiveLoadState = sessionPath
		? historyLoadState === "loading" && messages.length > 0
			? "ready"
			: historyLoadState
		: loadState;

	return {
		messages,
		searchMessages,
		pendingUsers,
		latestTurnInterrupted,
		activeAssistantMessageId,
		effectiveLoadState,
	};
}
