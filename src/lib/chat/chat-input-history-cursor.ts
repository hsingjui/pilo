export const CHAT_INPUT_HISTORY_LIMIT = 100;

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
