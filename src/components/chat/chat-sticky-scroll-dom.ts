import type { VirtualizerHandle } from "virtua";

const SCROLL_EPSILON_PX = 1;

export type ChatScrollElementLike = Pick<
	HTMLElement,
	"clientHeight" | "scrollHeight" | "scrollTop"
>;

export function getChatScrollMaxOffset(
	scrollElement: ChatScrollElementLike,
): number {
	return Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
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
}: {
	itemCount: number;
	vlist: Pick<VirtualizerHandle, "scrollToIndex"> | null;
	scrollElement: ChatScrollElementLike | null;
	bottomOffset?: number;
}) {
	if (itemCount <= 0) return;

	vlist?.scrollToIndex(itemCount - 1, {
		align: "end",
		offset: bottomOffset,
	});

	if (!scrollElement) return;
	const maxScrollTop = getChatScrollMaxOffset(scrollElement);
	if (Math.abs(scrollElement.scrollTop - maxScrollTop) <= SCROLL_EPSILON_PX) {
		return;
	}
	scrollElement.scrollTop = maxScrollTop;
}
