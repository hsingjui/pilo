import {
	memo,
	useMemo,
	useSyncExternalStore,
	type ComponentProps,
} from "react";

import { ChatConversationViewport } from "@/components/chat/chat-conversation-viewport";
import type { ChatConversationStore } from "@/components/chat/chat-conversation-store";
import { EMPTY_MESSAGES } from "@/components/chat/chat-mock-conversations";
import type { ChatMessage } from "@/lib/chat/conversation-types";

type Props = Omit<
	ComponentProps<typeof ChatConversationViewport>,
	"messages" | "activeAssistantMessageId" | "conversationStore"
> & {
	conversationStore: ChatConversationStore;
	historyPrefix: ChatMessage[];
	initialVirtualizerMessageCount?: number;
};

export const RemoteConversationViewport = memo(
	function RemoteConversationViewport({
		conversationStore,
		historyPrefix,
		initialVirtualizerCache,
		initialVirtualizerMessageCount,
		...props
	}: Props) {
		const timeline = useSyncExternalStore(
			conversationStore.subscribe,
			conversationStore.getTimelineSnapshot,
			conversationStore.getTimelineSnapshot,
		);
		const runtimeMessages = timeline?.messages ?? EMPTY_MESSAGES;
		const messages = useMemo(
			() =>
				historyPrefix.length > 0
					? [...historyPrefix, ...runtimeMessages]
					: runtimeMessages,
			[historyPrefix, runtimeMessages],
		);
		return (
			<ChatConversationViewport
				{...props}
				messages={messages}
				conversationStore={conversationStore}
				activeAssistantMessageId={timeline?.activeAssistantMessageId ?? null}
				initialVirtualizerCache={
					initialVirtualizerMessageCount === messages.length
						? initialVirtualizerCache
						: undefined
				}
			/>
		);
	},
);
