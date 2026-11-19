import { expect, test } from "nsh/test";

import type { ConversationState } from "@/lib/chat/conversation-types";
import { chatListView } from "../chat/chat-list-view";
import type { ChatTranscriptState } from "../state/chat-transcript-store";

function conversation(messages: number): ConversationState {
	return {
		messages: Array.from({ length: messages }, (_, index) => ({
			id: `user-${index}`,
			role: "user",
			text: "",
			time: "",
		})),
		active: null,
		pendingUsers: [],
	};
}

function state(
	status: ChatTranscriptState["status"],
	messages?: number,
): ChatTranscriptState {
	return {
		sessionKey: status === "closed" ? null : "chat",
		status,
		conversation: messages === undefined ? null : conversation(messages),
		historyPrefix: [],
		source: messages === undefined ? null : "history",
	};
}

test("no chat is open: the list shows nothing", () => {
	expect(chatListView(state("closed"), 0)).toBe("closed");
});

test("the first read of a chat shows the skeleton", () => {
	expect(chatListView(state("loading"), 0)).toBe("loading");
});

test("a read that follows one already shown keeps what it showed", () => {
	expect(chatListView(state("loading", 3), 3)).toBe("messages");
	expect(chatListView(state("loading", 0), 0)).toBe("empty");
});

test("a ready chat shows its messages, or that it has none", () => {
	expect(chatListView(state("ready", 3), 3)).toBe("messages");
	expect(chatListView(state("ready", 0), 0)).toBe("empty");
});

test("a failed read shows the failure, over a conversation kept from before too", () => {
	expect(chatListView(state("failed"), 0)).toBe("failed");
	expect(chatListView(state("failed", 3), 3)).toBe("failed");
});

test("a turn that cannot be rebuilt is waited for", () => {
	expect(chatListView(state("not_loaded"), 0)).toBe("waiting");
});
