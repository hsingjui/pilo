export type OutlineIndexedEntry = {
	messageIndex: number;
};

const OUTLINE_ANCHOR_TOLERANCE_PX = 1;

export const PLAIN_SHORT_CHAT_MAX_MESSAGES = 8;
export const PLAIN_SHORT_CHAT_HARD_MAX_MESSAGES = 16;

export function shouldInitializeShortChatPromoted({
	enabled,
	messageCount,
	streaming,
}: {
	enabled: boolean;
	messageCount: number;
	streaming: boolean;
}) {
	return (
		!enabled ||
		messageCount > PLAIN_SHORT_CHAT_HARD_MAX_MESSAGES ||
		(messageCount > PLAIN_SHORT_CHAT_MAX_MESSAGES && !streaming)
	);
}

export function shouldRenderPlainShortChat({
	enabled,
	promoted,
}: {
	enabled: boolean;
	promoted: boolean;
}) {
	return enabled && !promoted;
}

export function shouldPromoteShortChatVirtualization({
	enabled,
	promoted,
	active,
	ready,
	messageCount,
	streaming,
	sticky,
	preparingVisual = false,
}: {
	enabled: boolean;
	promoted: boolean;
	active: boolean;
	ready: boolean;
	messageCount: number;
	streaming: boolean;
	sticky: boolean;
	preparingVisual?: boolean;
}) {
	if (!enabled || promoted) return false;
	return (
		active &&
		ready &&
		messageCount > PLAIN_SHORT_CHAT_MAX_MESSAGES &&
		!streaming &&
		(preparingVisual || sticky)
	);
}

export function getOutlineIndexForMessageIndex(
	entries: readonly OutlineIndexedEntry[],
	messageIndex: number,
) {
	if (entries.length === 0) return -1;

	let low = 0;
	let high = entries.length - 1;
	let activeIndex = 0;

	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		if (entries[middle].messageIndex <= messageIndex) {
			activeIndex = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}

	return activeIndex;
}

export function getOutlineIndexForScrollOffset(
	entries: readonly OutlineIndexedEntry[],
	getMessageOffset: (messageIndex: number) => number,
	scrollOffset: number,
	isAtEnd = false,
) {
	if (entries.length === 0) return -1;
	if (isAtEnd) return entries.length - 1;

	const startedBy = scrollOffset + OUTLINE_ANCHOR_TOLERANCE_PX;
	let low = 0;
	let high = entries.length - 1;
	let activeIndex = 0;

	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const entry = entries[middle];
		if (getMessageOffset(entry.messageIndex) <= startedBy) {
			activeIndex = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}

	return activeIndex;
}
