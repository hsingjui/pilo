import { computed, type JSX, type ListSlot, untracked, View } from "nsh";

import type { ChatMessage } from "@/lib/chat/conversation-types";
import type { ChatTranscriptState } from "../state/chat-transcript-store";
import { ChatHistorySkeleton } from "./chat-history-skeleton";
import { ChatExpansion } from "./chat-expansion";
import { chatListView } from "./chat-list-view";
import { ChatLoadFailure } from "./chat-load-failure";
import { ChatMessages, type ChatScrollPosition } from "./chat-messages";
import { ChatTurnWaiting } from "./chat-turn-waiting";
import type {
	AssistantChatMessage,
	ChatMessageBody,
	ChatTextBody,
	ChatWorkPreferences,
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
	/** Draws a whole reply, in place of its texts and work. */
	assistantBody?: ChatMessageBody<AssistantChatMessage>;
	/** Draws each text of a reply between its work; Markdown without it. */
	assistantText?: ChatTextBody;
	/** The Host preferences that fold and time a reply's work; its defaults without them. */
	preferences?: () => ChatWorkPreferences | undefined;
	/** Forks the session at an assistant message; absent where forking is off. */
	onForkAssistant?: (messageId: string) => void;
	/** The assistant message a fork is running for. */
	forkingMessageId?: () => string | null;
	/** A turn in flight or a pending read disables forking. */
	forkDisabled?: () => boolean;
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
	// Where each chat was read to, so one opened again comes back there.
	const positions = new Map<string, ChatScrollPosition>();
	const savedPosition = () => {
		const key = untracked(sessionKey);
		return key === null ? null : (positions.get(key) ?? null);
	};
	const readPosition = (position: ChatScrollPosition) => {
		const key = untracked(sessionKey);
		if (key !== null) positions.set(key, position);
	};
	// What the user opened and closed in each chat, kept while the app runs.
	const expansions = new Map<string, ChatExpansion>();
	const expansionFor = () => {
		const key = untracked(sessionKey) ?? "";
		let expansion = expansions.get(key);
		if (!expansion) {
			expansion = new ChatExpansion();
			expansions.set(key, expansion);
		}
		return expansion;
	};
	const view = computed(() =>
		chatListView(transcript(), props.messages().length),
	);
	return (
		<View testID="chat-message-list" class="min-h-0 min-w-0 flex-1">
			{() => {
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
						// Only the message list is tied to a session, not the empty page.
						sessionKey();
						return (
							<ChatMessages
								messages={props.messages}
								userBody={props.userBody}
								assistantBody={props.assistantBody}
								assistantText={props.assistantText}
								expansion={expansionFor()}
								preferences={props.preferences}
								onForkAssistant={props.onForkAssistant}
								forkingMessageId={props.forkingMessageId}
								forkDisabled={props.forkDisabled}
								footer={props.footer}
								onVisibleRangeChange={props.onVisibleRangeChange}
								restorePosition={savedPosition()}
								onScrollPositionChange={readPosition}
							/>
						);
				}
			}}
		</View>
	);
}
