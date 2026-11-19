import { Text, View } from "nsh";

import { appLocale, t } from "../app/i18n";
import type { CompactionChatMessage } from "./chat-message-types";
import { ConversationColumn } from "./conversation-column";

/**
 * Where Pi compacted the context. The messages before it stay in the
 * session file, so this only marks the point.
 */
export function ChatCompactionMarker(props: {
	message: () => CompactionChatMessage;
}) {
	const label = () => {
		const { tokensBefore, time } = props.message();
		const text =
			tokensBefore === undefined
				? t("chat.contextCompacted")
				: t("chat.contextCompactedTokens", {
						tokens: tokensBefore.toLocaleString(appLocale()),
					});
		return time ? `${text} · ${time}` : text;
	};
	return (
		<ConversationColumn class="flex-row items-center gap-3 py-2">
			<View class="h-px flex-1 bg-border" />
			<Text class="font-sans text-xs font-medium text-muted-foreground">
				{label}
			</Text>
			<View class="h-px flex-1 bg-border" />
		</ConversationColumn>
	);
}
