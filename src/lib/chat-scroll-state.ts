const REPLY_RUNWAY_RATIO = 0.32;
const REPLY_RUNWAY_MIN_PX = 144;
const REPLY_RUNWAY_MAX_PX = 256;
const MEANINGFUL_OVERFLOW_PX = 48;

export function getReplyRunwayHeight({
	viewportHeight,
	scrollHeight,
	enabled = true,
}: {
	viewportHeight: number;
	scrollHeight: number;
	enabled?: boolean;
}): number | undefined {
	if (!enabled || viewportHeight <= 0) return undefined;
	if (scrollHeight - viewportHeight <= MEANINGFUL_OVERFLOW_PX) return undefined;

	return Math.round(
		Math.min(
			REPLY_RUNWAY_MAX_PX,
			Math.max(REPLY_RUNWAY_MIN_PX, viewportHeight * REPLY_RUNWAY_RATIO),
		),
	);
}
