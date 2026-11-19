import type { ConversationReducerContext } from "@/lib/chat/conversation-types";

export function reducerContext(
	now: () => number = Date.now,
): ConversationReducerContext {
	let messageId = 0;
	let contentId = 0;
	return {
		createMessageId: (kind) => `${kind}-${++messageId}`,
		createContentId: (kind) => `${kind}-${++contentId}`,
		now,
		formatTime: (timestampMs) =>
			new Date(timestampMs).toISOString().slice(11, 19),
	};
}
