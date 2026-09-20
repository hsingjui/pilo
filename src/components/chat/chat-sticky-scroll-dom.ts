import type { VirtualizerHandle } from "virtua";

const SCROLL_EPSILON_PX = 1;
const SCROLL_TO_LATEST_SHOW_MIN_PX = 96;
const SCROLL_TO_LATEST_SHOW_MAX_PX = 180;
const SCROLL_TO_LATEST_SHOW_VIEWPORT_RATIO = 0.22;
const SCROLL_TO_LATEST_HIDE_RATIO = 0.45;

export type ChatStickyScrollCorrectionMode =
	| "baseline"
	| "dom-only"
	| "virtua-only"
	| "none";

export type ChatScrollElementLike = Pick<
	HTMLElement,
	"clientHeight" | "scrollHeight" | "scrollTop"
>;

export function getChatScrollMaxOffset(
	scrollElement: ChatScrollElementLike,
): number {
	return Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
}

export function shouldShowChatScrollToLatest(
	scrollElement: ChatScrollElementLike,
	currentlyVisible: boolean,
): boolean {
	const maxScrollOffset = getChatScrollMaxOffset(scrollElement);
	if (maxScrollOffset <= 0) return false;

	const showThreshold = Math.min(
		SCROLL_TO_LATEST_SHOW_MAX_PX,
		Math.max(
			SCROLL_TO_LATEST_SHOW_MIN_PX,
			scrollElement.clientHeight * SCROLL_TO_LATEST_SHOW_VIEWPORT_RATIO,
		),
	);
	const hideThreshold = showThreshold * SCROLL_TO_LATEST_HIDE_RATIO;
	const distanceFromBottom = Math.max(
		0,
		maxScrollOffset - scrollElement.scrollTop,
	);

	return (
		distanceFromBottom >= (currentlyVisible ? hideThreshold : showThreshold)
	);
}

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
