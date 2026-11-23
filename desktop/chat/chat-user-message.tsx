import { computed, platform, Text, View } from "nsh";

import { t } from "../app/i18n";
import { createHover } from "../ui/hover";
import { ChatCopyButton } from "./chat-copy-button";
import type { ChatMessageBody, UserChatMessage } from "./chat-message-types";
import { ConversationColumn } from "./conversation-column";
import { chatMetadataText, chatPx } from "./layout";
import { ChatUserImages } from "./chat-user-images";
import { ChatUserMessageBody } from "./chat-user-message-body";

/** A prompt the user sent: a bubble at the end of the column. */
export function ChatUserMessage(props: {
	message: () => UserChatMessage;
	body?: ChatMessageBody<UserChatMessage>;
}) {
	const { message } = props;
	const hover = createHover();
	const reveal = () => !platform.desktop || hover.hovered();
	const hasText = () => Boolean(message().text.trim());
	const images = () => message().images ?? [];
	const hasImages = computed(() => images().length > 0);
	const showBubble = computed(
		() => Boolean(props.body) || hasText() || !hasImages(),
	);
	return (
		<ConversationColumn class="items-end py-3">
			<View class="max-w-[70%] items-end gap-1.5" {...hover.props}>
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
				{() => (hasImages() ? <ChatUserImages images={images} /> : null)}
				{() =>
					showBubble() ? (
						<View
							selectable
							class="max-w-full rounded-(--pilo-bubble-radius) border border-(--pilo-user-bubble-border) bg-(--pilo-user-bubble-bg) px-4 py-2.5"
						>
							{props.body ? (
								props.body(message)
							) : (
								<ChatUserMessageBody message={message} />
							)}
						</View>
					) : null
				}
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
