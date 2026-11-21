import { formatTime } from "@/components/chat/chat-page-utils";
import type { ConversationState } from "@shared/chat/conversation-types";

export {
	alignHistoryMessages,
	buildHistoryPrefix,
	HISTORY_PAGE_MESSAGE_COUNT,
	HISTORY_PREFETCH_MESSAGES,
	INITIAL_HISTORY_MESSAGE_COUNT,
	sameHistoryFingerprint,
} from "@shared/chat/chat-history-window-model";

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

function reviveExternalActivity<
	T extends {
		type: string;
		status?: "complete" | "running";
		result?: unknown;
	},
>(item: T): T {
	return item.type === "tool" && item.result === undefined
		? { ...item, status: "running" }
		: item;
}

export function markExternalTurnLive(
	state: ConversationState,
): ConversationState {
	if (state.active) return state;
	const index = state.messages.length - 1;
	const message = state.messages[index];
	if (message?.role !== "assistant" || message.completion !== "interrupted")
		return state;
	const messages = state.messages.slice();
	messages[index] = {
		...message,
		content: message.content?.map(reviveExternalActivity),
		activity: message.activity?.map(reviveExternalActivity),
		streaming: true,
		completion: undefined,
		errorMessage: undefined,
	};
	return {
		...state,
		messages,
		active: {
			turnStartedAtMs: message.timestampMs,
			assistantUpdatedAtMs: message.timestampMs,
			assistantMessageId: message.id,
			firstRuntimeUserSeen: false,
		},
	};
}
