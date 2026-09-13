export type OutlineIndexedEntry = {
	messageIndex: number;
};

const OUTLINE_ANCHOR_TOLERANCE_PX = 1;

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
