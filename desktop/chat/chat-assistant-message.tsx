import { computed, Text, View } from "nsh";

import { t } from "../app/i18n";
import { Spinner } from "../ui/spinner";
import { ChatMarkdown } from "./chat-markdown";
import type {
	AssistantChatMessage,
	ChatMessageBody,
} from "./chat-message-types";
import { ConversationColumn } from "./conversation-column";

const stalled = "PILO_STREAM_STALLED:";

/** A reply: its content, then what became of the turn. */
export function ChatAssistantMessage(props: {
	message: () => AssistantChatMessage;
	body?: ChatMessageBody<AssistantChatMessage>;
}) {
	const { message } = props;
	// A reply that failed or was stopped before any text has no body.
	const hasText = computed(() => message().text.length > 0);
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
				() =>
					hasText() ? (
						<View selectable>
							<ChatMarkdown text={() => message().text} />
						</View>
					) : null
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
