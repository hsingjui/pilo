import { computed, type JSX, type ListSlot, View } from "nsh";

import type { ChatMessage } from "@/lib/chat/conversation-types";
import type { ChatTranscriptState } from "../state/chat-transcript-store";
import { ChatHistorySkeleton } from "./chat-history-skeleton";
import { chatListView } from "./chat-list-view";
import { ChatLoadFailure } from "./chat-load-failure";
import { ChatMessages } from "./chat-messages";
import { ChatTurnWaiting } from "./chat-turn-waiting";
import type {
	AssistantChatMessage,
	ChatMessageBody,
	UserChatMessage,
} from "./chat-message-types";

export interface ChatMessageListProps {
	/** The open chat's transcript, as `ChatTranscriptStore` holds it. */
	transcript: () => ChatTranscriptState;
	/**
	 * Every message of the chat in order, as the store's `messages()` joins
	 * them: a row is kept by its place, so index i must always be message i.
	 */
	messages: () => readonly ChatMessage[];
	/** Reads the chat again after a failed read (the store's `refresh`). */
	onRetry?: () => Promise<void> | void;
	/** What a chat without messages shows. */
	empty?: () => JSX.Element;
	/** Draws a prompt's content in its bubble; plain text without it. */
	userBody?: ChatMessageBody<UserChatMessage>;
	/** Draws a reply's content; plain text without it. */
	assistantBody?: ChatMessageBody<AssistantChatMessage>;
	/** Under the last message, scrolling with the messages. */
	footer?: ListSlot;
	/**
	 * The first and last messages on screen (the store's `loadRange`, which
	 * reads the pages of history holding them).
	 */
	onVisibleRangeChange?: (startIndex: number, endIndex: number) => void;
}

/**
 * The messages of the open chat. Each chat gets a list of its own, so one
 * chat's rows and scroll position never show under another.
 */
export function ChatMessageList(props: ChatMessageListProps) {
	const { transcript } = props;
	const sessionKey = computed(() => transcript().sessionKey);
	const view = computed(() =>
		chatListView(transcript(), props.messages().length),
	);
	return (
		<View testID="chat-message-list" class="min-h-0 min-w-0 flex-1">
			{() => {
				sessionKey();
				switch (view()) {
					case "closed":
						return null;
					case "loading":
						return <ChatHistorySkeleton />;
					case "failed":
						return (
							<ChatLoadFailure
								message={() => transcript().message}
								onRetry={props.onRetry}
							/>
						);
					case "waiting":
						return <ChatTurnWaiting />;
					case "empty":
						return (
							<View
								testID="chat-empty"
								class="min-h-0 flex-1 items-center justify-center p-6"
							>
								{props.empty?.()}
							</View>
						);
					case "messages":
						return (
							<ChatMessages
								messages={props.messages}
								userBody={props.userBody}
								assistantBody={props.assistantBody}
								footer={props.footer}
								onVisibleRangeChange={props.onVisibleRangeChange}
							/>
						);
				}
			}}
		</View>
	);
}
