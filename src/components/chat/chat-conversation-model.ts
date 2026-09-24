import type { ChatHistoryWindowStore } from "@/components/chat/chat-history-window-store";
import { formatTime } from "@/components/chat/chat-page-utils";
import type { ChatMessage, ConversationState } from "@/lib/conversation-types";
import type {
	SessionHistoryFingerprint,
	SessionHistoryMessageIndexEntry,
} from "@/lib/sessions";

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
	for (let index = state.messages.length - 1; index >= 0; index -= 1) {
		const message = state.messages[index];
		if (!message || message.role !== "assistant") continue;
		if (message.completion !== "interrupted") return state;
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
	return state;
}

function historyPlaceholderMessage(
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
	if (descriptor.role === "compaction")
		return { ...common, role: "compaction" };
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
	snapshot: ReturnType<ChatHistoryWindowStore["getSnapshot"]>,
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
