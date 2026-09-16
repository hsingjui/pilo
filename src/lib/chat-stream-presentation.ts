import type { ConversationState } from "@/lib/conversation-types";

const SHORT_STREAM_CHARS = 1_500;
const MEDIUM_STREAM_CHARS = 6_000;
const LONG_STREAM_CHARS = 16_000;

/**
 * Visual presentation does not need to run at provider-token cadence. Keep short
 * replies feeling immediate, then progressively lower the commit rate as the
 * growing Markdown tail becomes more expensive to parse and measure.
 */
export function getStreamingPresentationIntervalMs(charCount: number) {
	const chars = Math.max(0, charCount);
	if (chars <= SHORT_STREAM_CHARS) return 50;
	if (chars <= MEDIUM_STREAM_CHARS) return 75;
	if (chars <= LONG_STREAM_CHARS) return 100;
	return 125;
}

/**
 * Approximate the expensive, currently-growing presentation payload. Assistant
 * text drives Markdown work; running thinking text also contributes visible DOM
 * work but is not included in message.text.
 */
export function getActiveStreamingPresentationChars(
	state: ConversationState | undefined,
) {
	const activeId = state?.active?.assistantMessageId;
	if (!state || !activeId) return 0;
	const message = state.messages.find((item) => item.id === activeId);
	if (!message || message.role !== "assistant") return 0;

	let chars = message.text.length;
	for (const item of message.content ?? []) {
		if (item.type === "thinking" && item.status === "running") {
			chars += item.text.length;
		}
	}
	return chars;
}
