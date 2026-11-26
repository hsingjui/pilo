import { Text, token, View } from "nsh";

import { t } from "../shell/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Spinner } from "../ui/spinner";

/**
 * A turn is running in a chat that has nothing to rebuild it from; its
 * messages show once the turn has settled.
 */
export function ChatTurnWaiting(props: { onRefresh?: () => void }) {
	return (
		<View
			testID="chat-turn-waiting"
			class="min-h-0 flex-1 items-center justify-center gap-2 p-6"
		>
			<View class="flex-row items-center gap-2">
				<Spinner size={16} color={token("muted-foreground")} />
				<Text class="font-sans text-sm font-medium text-foreground">
					{() => t("chat.waitingResponse")}
				</Text>
			</View>
			<Text class="max-w-sm text-center font-sans text-xs text-muted-foreground">
				{() => t("chat.waitingResponseDetail")}
			</Text>
			{props.onRefresh ? (
				<Button
					testID="chat-turn-waiting-refresh"
					variant="outline"
					size="sm"
					class="mt-1 gap-1.5"
					onPress={props.onRefresh}
				>
					<Icon name="RefreshCw" size={13} color={token("muted-foreground")} />
					<Text class="font-sans text-xs">
						{() => t("chat.refreshTranscript")}
					</Text>
				</Button>
			) : null}
		</View>
	);
}
