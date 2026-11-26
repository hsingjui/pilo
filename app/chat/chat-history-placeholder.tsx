import { computed, Text, token, View } from "nsh";

import type { ChatMessage } from "@shared/chat/conversation-types";
import { historyPlaceholderHeight } from "@shared/chat/history-placeholder-height";

import { t } from "../shell/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ConversationColumn } from "./conversation-column";

/**
 * A message not yet loaded: a quiet box at the height its content is
 * estimated to take, so the rows around it hold about their final places
 * while the message is on its way. When loading that page failed, exposes a
 * retry button instead of staying as a permanent gray skeleton.
 */
export function ChatHistoryPlaceholder(props: {
	message: () => ChatMessage;
	failed?: () => boolean;
	onRetry?: () => void;
}) {
	const { message } = props;
	const user = computed(() => message().role === "user");
	const height = computed(() => historyPlaceholderHeight(message()));
	return (
		<ConversationColumn class="py-3">
			<View
				testID="chat-history-placeholder"
				class={
					user()
						? "ml-auto w-[70%] max-w-[28rem] items-center justify-center rounded-(--pilo-bubble-radius) border border-foreground/10 bg-foreground/5"
						: "w-full items-center justify-center rounded-(--pilo-radius-lg) bg-foreground/5"
				}
				style={{ minHeight: height() }}
			>
				{() =>
					props.failed?.() && props.onRetry ? (
						<Button
							testID="chat-history-placeholder-retry"
							variant="ghost"
							size="sm"
							class="gap-1.5"
							onPress={props.onRetry}
						>
							<Icon
								name="RefreshCw"
								size={13}
								color={token("muted-foreground")}
							/>
							<Text class="font-sans text-xs text-muted-foreground">
								{() => t("chat.historyPageLoadFailed")}
							</Text>
						</Button>
					) : null
				}
			</View>
		</ConversationColumn>
	);
}
