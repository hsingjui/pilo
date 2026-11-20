import { computed, Text, View } from "nsh";

import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
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
	/** Forks the session at this reply; absent where forking is off. */
	onFork?: (messageId: string) => void;
	/** This reply's fork is running. */
	forking?: () => boolean;
	/** Another fork, or a turn in flight, disables the button. */
	forkDisabled?: () => boolean;
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
	// Only a cleanly finished reply can be a fork point, as in the Tauri app.
	const canFork = computed(
		() =>
			props.onFork != null &&
			message().streaming !== true &&
			message().completion !== "continued" &&
			!message().errorMessage &&
			message().stopReason !== "aborted",
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
				) : ending() || canFork() ? (
					<View class="mt-0.5 h-7 flex-row items-center gap-2">
						{() =>
							canFork() ? (
								<Button
									testID={`fork:${message().id}`}
									variant="ghost"
									size="sm"
									disabled={
										(props.forkDisabled?.() ?? false) ||
										(props.forking?.() ?? false)
									}
									accessibilityLabel={t("chat.forkNewSession")}
									onPress={() => props.onFork?.(message().id)}
								>
									{() =>
										props.forking?.() ? (
											<Spinner size={13} class="text-muted-foreground" />
										) : (
											<Icon
												name="GitFork"
												size={13}
												class="text-muted-foreground"
											/>
										)
									}
									<Text class="text-xs text-muted-foreground">
										{() =>
											props.forking?.()
												? t("chat.forking")
												: t("chat.forkNewSession")
										}
									</Text>
								</Button>
							) : null
						}
						<Text class="font-sans text-xs text-muted-foreground">
							{ending}
						</Text>
					</View>
				) : null
			}
		</ConversationColumn>
	);
}
