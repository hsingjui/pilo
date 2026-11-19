import { computed, type JSX, List, type ListSlot, View } from "nsh";

import type { ChatMessage } from "@/lib/chat/conversation-types";
import type { ChatTranscriptState } from "../state/chat-transcript-store";
import { scrollbarLook } from "../ui/scrollbar";
import { ChatHistorySkeleton } from "./chat-history-skeleton";
import { chatListView } from "./chat-list-view";
import { ChatLoadFailure } from "./chat-load-failure";
import { ChatMessageRow } from "./chat-message-row";
import { ChatTurnWaiting } from "./chat-turn-waiting";
import type {
	AssistantChatMessage,
	ChatMessageBody,
	UserChatMessage,
} from "./chat-message-types";

const noMessages: readonly ChatMessage[] = [];

export interface ChatMessageListProps {
	/** The open chat's transcript, as `ChatTranscriptStore` holds it. */
	transcript: () => ChatTranscriptState;
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
}

/**
 * The messages of the open chat. Each chat gets a list of its own, so one
 * chat's rows and scroll position never show under another.
 */
export function ChatMessageList(props: ChatMessageListProps) {
	const { transcript } = props;
	const sessionKey = computed(() => transcript().sessionKey);
	const view = computed(() => chatListView(transcript()));
	const messages = computed(
		() => transcript().conversation?.messages ?? noMessages,
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
							<List
								testID="chat-messages"
								class="min-h-0 flex-1"
								contentClass="pt-6 pb-10"
								each={messages()}
								keyExtractor={(message) => message.id}
								estimatedItemSize={96}
								initialScrollAtEnd
								scrollbar={{ vertical: scrollbarLook() }}
								footer={props.footer}
							>
								{(message) => (
									<ChatMessageRow
										message={message}
										userBody={props.userBody}
										assistantBody={props.assistantBody}
									/>
								)}
							</List>
						);
				}
			}}
		</View>
	);
}
