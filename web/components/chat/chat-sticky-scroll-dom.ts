import type { VirtualizerHandle } from "virtua";

import {
	getChatScrollMaxOffset,
	type ChatScrollElementLike,
} from "@shared/chat/chat-scroll-to-latest";

export {
	getChatScrollMaxOffset,
	shouldShowChatScrollToLatest,
	type ChatScrollElementLike,
} from "@shared/chat/chat-scroll-to-latest";

const SCROLL_EPSILON_PX = 1;

export type ChatStickyScrollCorrectionMode =
	| "baseline"
	| "dom-only"
	| "virtua-only"
	| "none";

export function getChatScrollBottomPadding(
	scrollElement: HTMLElement | null,
): number {
	if (!scrollElement || typeof getComputedStyle !== "function") return 0;
	const paddingBottom = Number.parseFloat(
		getComputedStyle(scrollElement).paddingBottom,
	);
	return Number.isFinite(paddingBottom) ? Math.max(0, paddingBottom) : 0;
}

export function scrollChatViewportToRealBottom({
	itemCount,
	vlist,
	scrollElement,
	bottomOffset = 0,
	mode = "baseline",
}: {
	itemCount: number;
	vlist: Pick<VirtualizerHandle, "scrollToIndex"> | null;
	scrollElement: ChatScrollElementLike | null;
	bottomOffset?: number;
	mode?: ChatStickyScrollCorrectionMode;
}) {
	if (itemCount <= 0) {
		return { virtuaScrolled: false, domScrolled: false };
	}

	let virtuaScrolled = false;
	let domScrolled = false;

	if (mode === "baseline" || mode === "virtua-only") {
		if (vlist) {
			vlist.scrollToIndex(itemCount - 1, {
				align: "end",
				offset: bottomOffset,
			});
			virtuaScrolled = true;
		}
	}

	if (mode === "virtua-only" || mode === "none" || !scrollElement) {
		return { virtuaScrolled, domScrolled };
	}
	const maxScrollTop = getChatScrollMaxOffset(scrollElement);
	if (Math.abs(scrollElement.scrollTop - maxScrollTop) <= SCROLL_EPSILON_PX) {
		return { virtuaScrolled, domScrolled };
	}
	scrollElement.scrollTop = maxScrollTop;
	domScrolled = true;
	return { virtuaScrolled, domScrolled };
}
