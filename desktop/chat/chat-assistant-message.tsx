import { computed, Text, View } from "nsh";

import { t } from "../app/i18n";
import { Spinner } from "../ui/spinner";
import { ChatAssistantWork } from "./chat-assistant-work";
import { ChatExpansion } from "./chat-expansion";
import { ChatMarkdown } from "./chat-markdown";
import type {
	AssistantChatMessage,
	ChatMessageBody,
	ChatTextBody,
	ChatWorkPreferences,
} from "./chat-message-types";
import { ConversationColumn } from "./conversation-column";

const stalled = "PILO_STREAM_STALLED:";

/** The Host's defaults, while its preferences are not loaded. */
export const defaultChatWorkPreferences: ChatWorkPreferences = {
	collapseCompletedActivity: true,
	showWorkDuration: true,
};

const markdownText: ChatTextBody = (text) => <ChatMarkdown text={text} />;

/** A reply: its texts and work, then what became of the turn. */
export function ChatAssistantMessage(props: {
	message: () => AssistantChatMessage;
	/** Draws the whole reply instead of its texts and work. */
	body?: ChatMessageBody<AssistantChatMessage>;
	/** Draws each text of the reply; Markdown without it. */
	text?: ChatTextBody;
	/** What the user opened and closed in this chat. */
	expansion?: ChatExpansion;
	preferences?: () => ChatWorkPreferences | undefined;
}) {
	const { message } = props;
	const expansion = props.expansion ?? new ChatExpansion();
	const preferences = () => props.preferences?.() ?? defaultChatWorkPreferences;
	const error = computed(() => {
		const text = message().errorMessage;
		return text?.startsWith(stalled) ? t("chat.modelStreamStalled") : text;
	});
	const streaming = computed(() => message().streaming === true);
	// What became of a finished turn: it was stopped, or when it ended.
	const ending = computed(() =>
		message().stopReason === "aborted" ? t("chat.stopped") : message().time,
	);
	return (
		<ConversationColumn class="py-3">
			{props.body ? (
				<View selectable>{props.body(message)}</View>
			) : (
				<ChatAssistantWork
					message={message}
					expansion={expansion}
					preferences={preferences}
					text={props.text ?? markdownText}
				/>
			)}
			{() =>
				error() ? (
					<View
						role="alert"
						selectable
						class="mt-2 rounded-(--pilo-radius-lg) border border-destructive/20 bg-destructive/5 px-3 py-2"
					>
						<Text class="font-sans text-xs leading-5 text-destructive">
							{error}
						</Text>
					</View>
				) : null
			}
			{() =>
				streaming() ? (
					<View class="mt-0.5 h-7 justify-center">
						<Spinner
							testID="chat-reply-streaming"
							size={14}
							class="text-muted-foreground"
							accessibilityLabel={t("chat.waitingResponse")}
						/>
					</View>
				) : ending() ? (
					<View class="mt-0.5 h-7 justify-center">
						<Text class="font-sans text-xs text-muted-foreground">
							{ending}
						</Text>
					</View>
				) : null
			}
		</ConversationColumn>
	);
}
