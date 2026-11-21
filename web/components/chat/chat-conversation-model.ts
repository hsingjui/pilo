import { formatTime } from "@/components/chat/chat-page-utils";

export {
	alignHistoryMessages,
	buildHistoryPrefix,
	HISTORY_PAGE_MESSAGE_COUNT,
	HISTORY_PREFETCH_MESSAGES,
	INITIAL_HISTORY_MESSAGE_COUNT,
	sameHistoryFingerprint,
} from "@shared/chat/chat-history-window-model";
export { markExternalTurnLive } from "@shared/chat/conversation-replay";

let localMessageSequence = 0;
let localActivitySequence = 0;

export function createLocalMessageId(
	kind: "user" | "assistant" | "compaction",
) {
	localMessageSequence += 1;
	return `local-${kind}-${Date.now()}-${localMessageSequence}`;
}

function createLocalContentId(kind: "thinking" | "text") {
	localActivitySequence += 1;
	return `local-${kind}-${Date.now()}-${localActivitySequence}`;
}

export const conversationReducerContext = {
	createMessageId: createLocalMessageId,
	createContentId: createLocalContentId,
	now: () => Date.now(),
	formatTime,
};
