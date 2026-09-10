export const CHAT_VIRTUALIZATION_THRESHOLD = 40;

export type OutlineIndexedEntry = {
	messageIndex: number;
};

export function shouldVirtualizeChatMessages(messageCount: number) {
	return messageCount >= CHAT_VIRTUALIZATION_THRESHOLD;
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
