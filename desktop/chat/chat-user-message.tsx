import { platform, signal, Text, View } from "nsh";

import { t } from "../app/i18n";
import { ChatCopyButton } from "./chat-copy-button";
import type { ChatMessageBody, UserChatMessage } from "./chat-message-types";
import { ConversationColumn } from "./conversation-column";
import { chatMetadataText, chatPx } from "./layout";

/** A prompt the user sent: a bubble at the end of the column. */
export function ChatUserMessage(props: {
	message: () => UserChatMessage;
	body?: ChatMessageBody<UserChatMessage>;
}) {
	const { message } = props;
	const hovered = signal(false);
	const reveal = () => !platform.desktop || hovered();
	const hasText = () => Boolean(message().text.trim());
	return (
		<ConversationColumn class="items-end py-3">
			<View
				class="max-w-[70%] items-end gap-1.5"
				onMouseEnter={() => hovered.set(true)}
				onMouseLeave={() => hovered.set(false)}
			>
				{() =>
					message().queued ? (
						<Text class="font-sans text-xs text-muted-foreground">
							{() =>
								message().queued === "steer"
									? t("chat.adjust")
									: t("chat.queued")
							}
						</Text>
					) : null
				}
				<View
					selectable
					class="max-w-full rounded-(--pilo-bubble-radius) border border-(--pilo-user-bubble-border) bg-(--pilo-user-bubble-bg) px-4 py-2.5"
				>
					{props.body ? (
						props.body(message)
					) : (
						<Text class="font-sans text-base leading-[1.6] text-foreground">
							{() => message().text}
						</Text>
					)}
				</View>
				{() =>
					hasText() || message().time ? (
						<View class="flex-row items-center" style={{ gap: chatPx(6) }}>
							{() =>
								hasText() ? (
									<ChatCopyButton
										text={() => message().text}
										visible={reveal()}
									/>
								) : null
							}
							{() =>
								message().time ? (
									<Text
										class="font-sans tabular-nums text-muted-foreground transition-opacity duration-150"
										style={{ ...chatMetadataText, opacity: reveal() ? 1 : 0 }}
									>
										{() => message().time}
									</Text>
								) : null
							}
						</View>
					) : null
				}
			</View>
		</ConversationColumn>
	);
}
