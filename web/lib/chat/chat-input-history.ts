import { CHAT_INPUT_HISTORY_LIMIT } from "@shared/chat/chat-input-history-cursor";

export {
	isChatInputHistoryCursorValid,
	moveChatInputHistory,
	CHAT_INPUT_HISTORY_LIMIT,
} from "@shared/chat/chat-input-history-cursor";
export type { ChatInputHistoryDirection } from "@shared/chat/chat-input-history-cursor";

const STORAGE_KEY = "pilo.chatInputHistory.v1";

type StoredChatInputHistory = Record<string, string[]>;

function sanitizeEntries(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.slice(-CHAT_INPUT_HISTORY_LIMIT);
}

function readStore(): StoredChatInputHistory {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return {};
		return parsed as StoredChatInputHistory;
	} catch {
		return {};
	}
}

export function readChatInputHistory(projectId: string | null | undefined) {
	if (!projectId) return [];
	const store = readStore();
	return sanitizeEntries(store[projectId]);
}

export function appendChatInputHistory(
	projectId: string | null | undefined,
	text: string,
) {
	if (!projectId || typeof window === "undefined") return;
	const entry = text.trim();
	if (!entry) return;

	const store = readStore();
	const current = sanitizeEntries(store[projectId]);
	if (current[current.length - 1] === entry) return;
	store[projectId] = [...current, entry].slice(-CHAT_INPUT_HISTORY_LIMIT);

	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
	} catch {
		// Input history is a convenience feature; storage failures should never block sending.
	}
}
