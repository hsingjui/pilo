export const MAX_CHAT_UI_STATE_CACHE_ENTRIES = 64;

export type ChatUiState = {
	draft: string;
	scrollTop: number;
	sticky: boolean;
	deferredSubmissions: string[];
};

export type ChatUiStatePatch = Partial<ChatUiState>;

const EMPTY_CHAT_UI_STATE: ChatUiState = {
	draft: "",
	scrollTop: 0,
	sticky: true,
	deferredSubmissions: [],
};

export type ChatUiStateCache = ReturnType<typeof createChatUiStateCache>;

export function createChatUiStateCache(
	limit = MAX_CHAT_UI_STATE_CACHE_ENTRIES,
) {
	const entries = new Map<string, ChatUiState>();

	const touch = (key: string, value: ChatUiState) => {
		entries.delete(key);
		entries.set(key, value);
		while (entries.size > limit) {
			const oldest = entries.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			entries.delete(oldest);
		}
	};

	return {
		get(key: string): ChatUiState {
			const existing = entries.get(key);
			if (!existing) return EMPTY_CHAT_UI_STATE;
			touch(key, existing);
			return existing;
		},
		patch(key: string, patch: ChatUiStatePatch) {
			const current = entries.get(key) ?? EMPTY_CHAT_UI_STATE;
			const next = { ...current, ...patch };
			touch(key, next);
		},
		rekey(previousKey: string, nextKey: string) {
			if (previousKey === nextKey) return;
			const previous = entries.get(previousKey);
			if (!previous) return;
			entries.delete(previousKey);
			const existing = entries.get(nextKey);
			touch(nextKey, existing ? { ...existing, ...previous } : previous);
		},
		delete(key: string) {
			entries.delete(key);
		},
		size() {
			return entries.size;
		},
	};
}
