import { useCallback, useEffect, useMemo, useState } from "react";
import type { CacheSnapshot } from "virtua";

import type {
	ChatUiState,
	ChatUiStatePatch,
} from "@/components/app/chat-ui-state-cache";
import { routeInitialDeferredSubmissions } from "@/components/chat/chat-submission-state";

const EMPTY_UI_STATE: ChatUiState = {
	draft: "",
	scrollTop: 0,
	sticky: true,
	deferredSubmissions: [],
};

/**
 * Owns the per-controller chat UI state cache: the initial read, the deferred
 * submission handoff, and the draft/scroll/virtualizer writers that the viewport
 * persists through. Call it before `useChatConversation` so the restored draft
 * and queued messages seed those hooks.
 */
export function useChatPageUiState({
	uiStateKey,
	readUiState,
	writeUiState,
	sessionPath,
	active,
}: {
	uiStateKey?: string;
	readUiState?: (key: string) => ChatUiState;
	writeUiState?: (key: string, patch: ChatUiStatePatch) => void;
	sessionPath?: string;
	active: boolean;
}) {
	const [initialUiState] = useState<ChatUiState>(() =>
		uiStateKey && readUiState ? readUiState(uiStateKey) : EMPTY_UI_STATE,
	);
	const initialDeferredSubmissions = useMemo(
		() =>
			routeInitialDeferredSubmissions(
				sessionPath,
				initialUiState.deferredSubmissions,
			),
		[initialUiState.deferredSubmissions, sessionPath],
	);
	useEffect(() => {
		if (
			sessionPath ||
			!uiStateKey ||
			!writeUiState ||
			initialUiState.deferredSubmissions.length === 0
		) {
			return;
		}
		// New chats hand the fallback queue directly to the runtime. Existing-session
		// queues stay persisted until history is ready and the page actually drains them.
		writeUiState(uiStateKey, { deferredSubmissions: [] });
	}, [
		initialUiState.deferredSubmissions,
		sessionPath,
		uiStateKey,
		writeUiState,
	]);
	const persistDraft = useMemo(
		() =>
			uiStateKey && writeUiState
				? (value: string) => writeUiState(uiStateKey, { draft: value })
				: undefined,
		[uiStateKey, writeUiState],
	);
	const persistScrollState = useCallback(
		(state: { scrollTop: number; sticky: boolean }) => {
			if (!active || !uiStateKey || !writeUiState) return;
			writeUiState(uiStateKey, state);
		},
		[active, uiStateKey, writeUiState],
	);
	const persistVirtualizerCache = useCallback(
		(cache: CacheSnapshot, messageCount: number) => {
			if (!active || !uiStateKey || !writeUiState) return;
			writeUiState(uiStateKey, {
				virtualizerCache: cache,
				virtualizerMessageCount: messageCount,
			});
		},
		[active, uiStateKey, writeUiState],
	);
	return {
		initialUiState,
		initialDeferredSubmissions,
		persistDraft,
		persistScrollState,
		persistVirtualizerCache,
	};
}
