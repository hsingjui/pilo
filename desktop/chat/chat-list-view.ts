import type { ChatTranscriptState } from "../state/chat-transcript-store";

/** What the message list shows for a transcript state. */
export type ChatListView =
	| "closed"
	| "loading"
	| "failed"
	| "waiting"
	| "empty"
	| "messages";

/**
 * A read that follows one already shown keeps the conversation on screen, so
 * a refresh never swaps the messages for the skeleton.
 */
export function chatListView(state: ChatTranscriptState): ChatListView {
	const { status, conversation } = state;
	if (status === "closed") return "closed";
	if (status === "failed") return "failed";
	if (status === "not_loaded") return "waiting";
	if (!conversation) return "loading";
	return conversation.messages.length > 0 ? "messages" : "empty";
}
