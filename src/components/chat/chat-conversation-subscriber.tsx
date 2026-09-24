import { memo, useEffect, useState, type ReactNode } from "react";

import type { ChatConversationStore } from "@/components/chat/chat-conversation-store";
import type { ChatHistoryWindowStore } from "@/components/chat/chat-history-window-store";
import { useChatConversationView } from "@/components/chat/use-chat-conversation-view";
import type { ChatMessage } from "@/lib/conversation-types";

type ChatConversationSubscriberProps = {
	active: boolean;
	conversationStore: ChatConversationStore;
	historyStore: ChatHistoryWindowStore;
	baseMessages: ChatMessage[];
	sessionPath?: string;
	historyLoadState: "ready" | "loading" | "error";
	loadState: "ready" | "loading" | "error";
	children: (
		view: ReturnType<typeof useChatConversationView>,
		live: boolean,
	) => ReactNode;
};

/**
 * Keeps the last visual snapshot mounted while this controller is hidden, but
 * disconnects it from background store updates. On reactivation we first paint
 * the frozen DOM, then reconnect on the next frame so session switching is an
 * urgent, bounded operation rather than a full hidden-output catch-up render.
 */
export const ChatConversationSubscriber = memo(
	function ChatConversationSubscriber({
		active,
		conversationStore,
		historyStore,
		baseMessages,
		sessionPath,
		historyLoadState,
		loadState,
		children,
	}: ChatConversationSubscriberProps) {
		const [live, setLive] = useState(active);
		useEffect(() => {
			if (active === live) return;
			const frame = requestAnimationFrame(() => setLive(active));
			return () => cancelAnimationFrame(frame);
		}, [active, live]);
		const view = useChatConversationView({
			conversationStore,
			historyStore,
			baseMessages,
			sessionPath,
			historyLoadState,
			loadState,
			live,
		});
		return children(view, live);
	},
	(previous, next) => !previous.active && !next.active,
);
