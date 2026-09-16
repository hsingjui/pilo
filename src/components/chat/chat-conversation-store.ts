import type { ConversationState } from "@/lib/conversation-types";

export type ChatConversationStore = ReturnType<
	typeof createChatConversationStore
>;

/**
 * Runtime-owned conversation state. The Pi event/controller path writes here
 * independently of React; only the mounted conversation view subscribes.
 */
export function createChatConversationStore() {
	let snapshot: ConversationState | undefined;
	const listeners = new Set<() => void>();

	return {
		getSnapshot() {
			return snapshot;
		},
		setSnapshot(next: ConversationState) {
			if (snapshot === next) return;
			snapshot = next;
			for (const listener of listeners) listener();
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
