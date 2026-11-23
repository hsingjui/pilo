import { Text, View } from "nsh";

import { t } from "../shell/i18n";
import { ErrorState } from "../ui/state-view";
import { ConversationColumn } from "./conversation-column";

/**
 * The chat could not be read; with `onRetry` the user can read it again.
 * React's viewport shows `ErrorState` in the conversation column.
 */
export function ChatLoadFailure(props: {
	message: () => string | undefined;
	onRetry?: () => Promise<void> | void;
}) {
	return (
		<View class="min-h-0 flex-1 justify-center">
			<ConversationColumn class="items-center">
				<ErrorState
					testID="chat-load-failed"
					title={() => t("chat.sessionLoadFailed")}
					description={() => t("chat.sessionLoadDescription")}
					detail={
						props.message() ? (
							<View selectable>
								<Text
									testID="chat-load-failed-message"
									class="text-center font-mono text-xs leading-5 text-muted-foreground"
								>
									{props.message}
								</Text>
							</View>
						) : undefined
					}
					onRetry={props.onRetry}
					retryLabel={() => t("common.retry")}
					retryTestID="chat-load-retry"
				/>
			</ConversationColumn>
		</View>
	);
}
