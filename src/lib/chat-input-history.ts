const STORAGE_KEY = "pilo.chatInputHistory.v1";
export const CHAT_INPUT_HISTORY_LIMIT = 100;

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

export type ChatInputHistoryDirection = "older" | "newer";

export function isChatInputHistoryCursorValid(
	entries: readonly string[],
	cursor: number | null,
	value: string,
) {
	return cursor === null || entries[cursor] === value;
}

export function moveChatInputHistory(
	entries: readonly string[],
	cursor: number | null,
	direction: ChatInputHistoryDirection,
): { handled: boolean; cursor: number | null; value: string } {
	if (entries.length === 0) {
		return { handled: false, cursor: null, value: "" };
	}

	if (cursor === null) {
		if (direction === "newer") {
			return { handled: false, cursor: null, value: "" };
		}
		const nextCursor = entries.length - 1;
		return {
			handled: true,
			cursor: nextCursor,
			value: entries[nextCursor] ?? "",
		};
	}

	if (direction === "older") {
		const nextCursor = Math.max(0, cursor - 1);
		return {
			handled: true,
			cursor: nextCursor,
			value: entries[nextCursor] ?? "",
		};
	}

	if (cursor >= entries.length - 1) {
		return { handled: true, cursor: null, value: "" };
	}
	const nextCursor = cursor + 1;
	return {
		handled: true,
		cursor: nextCursor,
		value: entries[nextCursor] ?? "",
	};
}
