import type { ChatHistoryWindowSnapshot } from "@/components/chat/chat-history-window-store";
import type { ChatMessage, ConversationState } from "@/lib/conversation-types";
import type {
	SessionHistoryFingerprint,
	SessionHistoryMessageIndexEntry,
} from "@/lib/sessions";
import { formatTime } from "@/components/chat/chat-page-utils";

export const INITIAL_HISTORY_MESSAGE_COUNT = 80;
export const HISTORY_PAGE_MESSAGE_COUNT = 48;
export const HISTORY_PREFETCH_MESSAGES = 16;

export function historyPlaceholderMessage(
	descriptor: SessionHistoryMessageIndexEntry,
): ChatMessage {
	const common = {
		id: descriptor.id,
		text: descriptor.preview,
		time:
			descriptor.timestampMs === undefined
				? ""
				: formatTime(descriptor.timestampMs),
		timestampMs: descriptor.timestampMs,
		historyPlaceholder: true as const,
		historyEstimatedChars: descriptor.estimatedChars,
	};
	if (descriptor.role === "user") return { ...common, role: "user" };
	if (descriptor.role === "compaction") {
		return { ...common, role: "compaction" };
	}
	return { ...common, role: "assistant" };
}

export function alignHistoryMessages(
	state: ConversationState,
	directory: readonly SessionHistoryMessageIndexEntry[],
	startIndex: number,
): ConversationState {
	if (state.messages.length === 0) return state;
	let activeAssistantMessageId = state.active?.assistantMessageId;
	const messages = state.messages.map((message, offset) => {
		const descriptor = directory[startIndex + offset];
		if (!descriptor || descriptor.role !== message.role) return message;
		if (activeAssistantMessageId === message.id) {
			activeAssistantMessageId = descriptor.id;
		}
		return message.id === descriptor.id
			? message
			: { ...message, id: descriptor.id };
	});
	return {
		...state,
		messages,
		active: state.active
			? { ...state.active, assistantMessageId: activeAssistantMessageId }
			: null,
	};
}

export function sameHistoryFingerprint(
	left: SessionHistoryFingerprint | null,
	right: SessionHistoryFingerprint | null,
) {
	return (
		left?.fileSize === right?.fileSize &&
		left?.fileMtimeNs === right?.fileMtimeNs
	);
}

export function buildHistoryPrefix(
	snapshot: Pick<
		ChatHistoryWindowSnapshot,
		"directory" | "hydrated" | "runtimeBaseStart"
	>,
) {
	const messages: ChatMessage[] = [];
	for (let index = 0; index < snapshot.runtimeBaseStart; index += 1) {
		const descriptor = snapshot.directory[index];
		if (!descriptor) continue;
		messages.push(
			snapshot.hydrated.get(index) ?? historyPlaceholderMessage(descriptor),
		);
	}
	return messages;
}
