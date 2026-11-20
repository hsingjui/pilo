import { computed, View } from "nsh";

import type { ChatMessage } from "@/lib/chat/conversation-types";
import { historyPlaceholderHeight } from "@/lib/chat/history-placeholder-height";

import { ConversationColumn } from "./conversation-column";

/**
 * A message not yet loaded: a quiet box at the height its content is
 * estimated to take, so the rows around it hold about their final places
 * while the message is on its way. Mirrors the WebUI's history placeholder.
 */
export function ChatHistoryPlaceholder(props: { message: () => ChatMessage }) {
	const { message } = props;
	const user = computed(() => message().role === "user");
	const height = computed(() => historyPlaceholderHeight(message()));
	return (
		<ConversationColumn class="py-3">
			<View
				testID="chat-history-placeholder"
				class={
					user()
						? "ml-auto w-[70%] max-w-[28rem] rounded-(--pilo-bubble-radius) border border-foreground/10 bg-foreground/5"
						: "w-full rounded-(--pilo-radius-lg) bg-foreground/5"
				}
				style={{ height: height() }}
			/>
		</ConversationColumn>
	);
}
