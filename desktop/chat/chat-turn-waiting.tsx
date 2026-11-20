import { Text, token, View } from "nsh";

import { t } from "../app/i18n";
import { Spinner } from "../ui/spinner";

/**
 * A turn is running in a chat that has nothing to rebuild it from; its
 * messages show once the turn has settled.
 */
export function ChatTurnWaiting() {
	return (
		<View
			testID="chat-turn-waiting"
			class="min-h-0 flex-1 flex-row items-center justify-center gap-2 p-6"
		>
			<Spinner size={16} color={token("muted-foreground")} />
			<Text class="font-sans text-sm text-muted-foreground">
				{() => t("chat.waitingResponse")}
			</Text>
		</View>
	);
}
