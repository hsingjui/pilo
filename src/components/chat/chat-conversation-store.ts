import type {
	ChatMessage,
	ConversationState,
} from "@/lib/chat/conversation-types";

type TimelineSnapshot = {
	messages: ChatMessage[];
	activeAssistantMessageId: string | null;
	pendingUsers: ConversationState["pendingUsers"];
};

function activeTail(state: ConversationState) {
	const last = state.messages[state.messages.length - 1];
	return last?.role === "assistant" &&
		last.streaming &&
		last.id === state.active?.assistantMessageId
		? last
		: undefined;
}

export type ChatConversationStore = ReturnType<
	typeof createChatConversationStore
>;

/**
 * Runtime-owned conversation state. The Pi event/controller path writes here
 * independently of React; only the mounted conversation view subscribes.
 */
export function createChatConversationStore() {
	let snapshot: ConversationState | undefined;
	let timeline: TimelineSnapshot | undefined;
	let streamingTail: ReturnType<typeof activeTail>;
	const listeners = new Set<() => void>();

	return {
		getSnapshot() {
			return snapshot;
		},
		getTimelineSnapshot() {
			return timeline;
		},
		getStreamingTail() {
			return streamingTail;
		},
		setSnapshot(next: ConversationState) {
			if (snapshot === next) return;
			const tail = activeTail(next);
			const activeAssistantMessageId = next.active?.assistantMessageId ?? null;
			const previousMessages = snapshot?.messages;
			let messages = next.messages;
			// Keep Virtua's data stable when only the streaming row changes. History
			// reconciliation can replace other rows without changing the length.
			if (
				timeline &&
				previousMessages &&
				tail &&
				streamingTail?.id === tail.id &&
				streamingTail.completion === tail.completion &&
				streamingTail.historyPlaceholder === tail.historyPlaceholder &&
				previousMessages.length === messages.length &&
				(previousMessages === messages ||
					messages.every(
						(message, index) =>
							index === messages.length - 1 ||
							message === previousMessages[index],
					))
			) {
				messages = timeline.messages;
			}
			if (
				!timeline ||
				timeline.messages !== messages ||
				timeline.activeAssistantMessageId !== activeAssistantMessageId ||
				timeline.pendingUsers !== next.pendingUsers
			) {
				timeline = {
					messages,
					activeAssistantMessageId,
					pendingUsers: next.pendingUsers,
				};
			}
			snapshot = next;
			streamingTail = tail;
			for (const listener of listeners) listener();
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
