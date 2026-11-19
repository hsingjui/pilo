import { Text, View } from "nsh";

import { t } from "../app/i18n";
import type { ChatMessageBody, UserChatMessage } from "./chat-message-types";
import { ConversationColumn } from "./conversation-column";

/** A prompt the user sent: a bubble at the end of the column. */
export function ChatUserMessage(props: {
	message: () => UserChatMessage;
	body?: ChatMessageBody<UserChatMessage>;
}) {
	const { message } = props;
	return (
		<ConversationColumn class="items-end py-3">
			<View class="max-w-[70%] items-end gap-1.5">
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
					message().time ? (
						<Text class="font-sans text-xs text-muted-foreground">
							{() => message().time}
						</Text>
					) : null
				}
			</View>
		</ConversationColumn>
	);
}
