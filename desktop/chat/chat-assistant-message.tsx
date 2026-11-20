import { computed, signal, Text, View } from "nsh";

import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Spinner } from "../ui/spinner";
import { Tooltip } from "../ui/tooltip";
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
	/** Forks the session at this reply; absent where forking is off. */
	onFork?: (messageId: string) => void;
	/** This reply's fork is running. */
	forking?: () => boolean;
	/** Another fork, or a turn in flight, disables the button. */
	forkDisabled?: () => boolean;
}) {
	const { message } = props;
	const expansion = props.expansion ?? new ChatExpansion();
	const preferences = () => props.preferences?.() ?? defaultChatWorkPreferences;
	// The action row under a finished reply shows on hover or keyboard focus,
	// like the Tauri message footer.
	const hovered = signal(false);
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
		<ConversationColumn
			class="py-3"
			onMouseEnter={() => hovered.set(true)}
			onMouseLeave={() => hovered.set(false)}
		>
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
				) : ending() || canFork() ? (
					<View
						class="mt-0.5 min-h-7 flex-row flex-wrap items-center gap-2"
						style={{
							opacity: hovered() ? 100 : 0,
							transitionProperty: "opacity",
							transitionDuration: "150ms",
						}}
						focusWithinStyle={{ opacity: 100 }}
					>
						{() =>
							canFork() ? (
								<Button
									testID={`fork:${message().id}`}
									variant="ghost"
									size="icon"
									class="size-7 rounded-md text-muted-foreground"
									disabled={
										(props.forkDisabled?.() ?? false) ||
										(props.forking?.() ?? false)
									}
									accessibilityLabel={t("chat.forkNewSession")}
									tooltip={
										<Tooltip>
											<Text>
												{() =>
													props.forking?.()
														? t("chat.forking")
														: t("chat.forkNewSession")
												}
											</Text>
										</Tooltip>
									}
									onPress={() => props.onFork?.(message().id)}
								>
									{() =>
										props.forking?.() ? (
											<Spinner size={14} class="text-muted-foreground" />
										) : (
											<Icon
												name="GitFork"
												size={14}
												class="text-muted-foreground"
											/>
										)
									}
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
