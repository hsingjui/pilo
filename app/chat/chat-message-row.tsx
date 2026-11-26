import { computed } from "nsh";

import type { ChatMessage } from "@shared/chat/conversation-types";
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
	index?: () => number;
	isPlaceholderFailed?: (index: number) => boolean;
	onRetryPlaceholder?: (index: number) => void;
	userBody?: ChatMessageBody<UserChatMessage>;
	assistantBody?: ChatMessageBody<AssistantChatMessage>;
	assistantText?: ChatTextBody;
	expansion?: ChatExpansion;
	preferences?: () => ChatWorkPreferences | undefined;
	/** Forks the session at an assistant message; absent where forking is off. */
	onForkAssistant?: (messageId: string) => void;
	/** Whether the current chat allows forking at assistant replies. */
	canForkAssistant?: () => boolean;
	/** The assistant message a fork is running for. */
	forkingMessageId?: () => string | null;
	/** A turn in flight or a pending read disables forking. */
	forkDisabled?: () => boolean;
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
			return (
				<ChatHistoryPlaceholder
					message={message}
					failed={
						props.isPlaceholderFailed && props.index
							? () => props.isPlaceholderFailed!(props.index!())
							: undefined
					}
					onRetry={
						props.onRetryPlaceholder && props.index
							? () => props.onRetryPlaceholder!(props.index!())
							: undefined
					}
				/>
			);
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
						onFork={props.onForkAssistant}
						canFork={props.canForkAssistant}
						forking={() => props.forkingMessageId?.() === message().id}
						forkDisabled={props.forkDisabled}
					/>
				);
			case "compaction":
				return (
					<ChatCompactionMarker
						message={message as () => CompactionChatMessage}
						expansion={props.expansion}
					/>
				);
		}
	};
}
