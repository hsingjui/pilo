/** 与消息列表跟底阈值对齐，避免出现“既不自动跟底又不出现回到底部按钮”的死区。 */
export const CHAT_FOLLOW_BOTTOM_THRESHOLD_PX = 24;

const SCROLL_TO_LATEST_HIDE_THRESHOLD_PX = 12;

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

	const distanceFromBottom = Math.max(
		0,
		maxScrollOffset - scrollElement.scrollTop,
	);

	return (
		distanceFromBottom >=
		(currentlyVisible
			? SCROLL_TO_LATEST_HIDE_THRESHOLD_PX
			: CHAT_FOLLOW_BOTTOM_THRESHOLD_PX)
	);
}
