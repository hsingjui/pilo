import { signal, Text, View } from "nsh";

import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

/** The chat could not be read; with `onRetry` the user can read it again. */
export function ChatLoadFailure(props: {
	message: () => string | undefined;
	onRetry?: () => Promise<void> | void;
}) {
	const retrying = signal(false);
	const retry = async () => {
		retrying.set(true);
		try {
			await props.onRetry?.();
		} finally {
			retrying.set(false);
		}
	};
	return (
		<View
			testID="chat-load-failed"
			role="alert"
			class="min-h-0 flex-1 items-center justify-center gap-3 p-6"
		>
			<Icon name="CircleAlert" size={20} class="text-muted-foreground" />
			<View class="max-w-md items-center gap-1">
				<Text class="text-center font-sans text-sm font-medium text-foreground">
					{() => t("chat.sessionLoadFailed")}
				</Text>
				<Text class="text-center font-sans text-xs leading-5 text-muted-foreground">
					{() => t("chat.sessionLoadDescription")}
				</Text>
				{() =>
					props.message() ? (
						<View selectable>
							<Text
								testID="chat-load-failed-message"
								class="text-center font-mono text-xs leading-5 text-muted-foreground"
							>
								{props.message}
							</Text>
						</View>
					) : null
				}
			</View>
			{props.onRetry ? (
				<Button
					testID="chat-load-retry"
					variant="outline"
					size="sm"
					disabled={retrying()}
					onPress={() => void retry()}
				>
					<Text>{() => t("common.retry")}</Text>
				</Button>
			) : null}
		</View>
	);
}
