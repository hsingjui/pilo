const SCROLL_TO_LATEST_SHOW_MIN_PX = 96;
const SCROLL_TO_LATEST_SHOW_MAX_PX = 180;
const SCROLL_TO_LATEST_SHOW_VIEWPORT_RATIO = 0.22;
const SCROLL_TO_LATEST_HIDE_RATIO = 0.45;

/** A scroll view's metrics, named as a DOM element's. */
export type ChatScrollElementLike = {
	clientHeight: number;
	scrollHeight: number;
	scrollTop: number;
};

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
