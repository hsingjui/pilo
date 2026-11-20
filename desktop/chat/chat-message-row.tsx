import { computed } from "nsh";

import type { ChatMessage } from "@/lib/chat/conversation-types";
import { ChatAssistantMessage } from "./chat-assistant-message";
import { ChatCompactionMarker } from "./chat-compaction-marker";
import type { ChatExpansion } from "./chat-expansion";
import { ChatHistoryPlaceholder } from "./chat-history-placeholder";
import type {
	AssistantChatMessage,
	ChatMessageBody,
	ChatTextBody,
	ChatWorkPreferences,
	CompactionChatMessage,
	UserChatMessage,
} from "./chat-message-types";
import { ChatUserMessage } from "./chat-user-message";

export interface ChatMessageRowProps {
	message: () => ChatMessage;
	userBody?: ChatMessageBody<UserChatMessage>;
	assistantBody?: ChatMessageBody<AssistantChatMessage>;
	assistantText?: ChatTextBody;
	expansion?: ChatExpansion;
	preferences?: () => ChatWorkPreferences | undefined;
}

/**
 * One message of the list. A list cell is reused for other messages, so the
 * row follows its message's role and each part reads the message it shows.
 */
export function ChatMessageRow(props: ChatMessageRowProps) {
	const { message } = props;
	const placeholder = computed(() => message().historyPlaceholder === true);
	const role = computed(() => message().role);
	return () => {
		if (placeholder()) {
			return <ChatHistoryPlaceholder message={message} />;
		}
		switch (role()) {
			case "user":
				return (
					<ChatUserMessage
						message={message as () => UserChatMessage}
						body={props.userBody}
					/>
				);
			case "assistant":
				return (
					<ChatAssistantMessage
						message={message as () => AssistantChatMessage}
						body={props.assistantBody}
						text={props.assistantText}
						expansion={props.expansion}
						preferences={props.preferences}
					/>
				);
			case "compaction":
				return (
					<ChatCompactionMarker
						message={message as () => CompactionChatMessage}
					/>
				);
		}
	};
}
