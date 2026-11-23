import { computed, Text, View } from "nsh";

import { appLocale, t } from "../shell/i18n";
import { Icon } from "../ui/icon";
import { ChatDisclosureRow } from "./chat-disclosure-row";
import { ChatExpansion } from "./chat-expansion";
import { ChatMarkdown } from "./chat-markdown";
import type { CompactionChatMessage } from "./chat-message-types";
import { ConversationColumn } from "./conversation-column";

/**
 * Where Pi compacted the context, with its summary. The messages before it
 * stay in the conversation.
 */
export function ChatCompactionMarker(props: {
	message: () => CompactionChatMessage;
	expansion?: ChatExpansion;
}) {
	const expansion = props.expansion ?? new ChatExpansion();
	const key = () => `compaction:${props.message().id}`;
	const summary = computed(() => props.message().text.trim());
	const hasSummary = computed(() => summary().length > 0);
	const open = computed(() => hasSummary() && expansion.isOpen(key(), false));
	const label = computed(() => {
		const { tokensBefore, time } = props.message();
		const text =
			tokensBefore === undefined
				? t("chat.contextCompacted")
				: t("chat.contextCompactedTokens", {
						tokens: tokensBefore.toLocaleString(appLocale()),
					});
		return time ? `${text} · ${time}` : text;
	});
	return (
		<ConversationColumn class="py-2">
			<View class="flex-row items-center gap-3">
				<View class="h-px flex-1 bg-border" />
				<ChatDisclosureRow
					class="min-w-0 shrink"
					accessibilityLabel={label()}
					expanded={hasSummary() ? open() : undefined}
					disabled={!hasSummary()}
					onPress={() => expansion.setOpen(key(), !open())}
				>
					{() =>
						hasSummary() ? (
							<Icon name={open() ? "ChevronDown" : "ChevronRight"} size={14} />
						) : null
					}
					<Text class="min-w-0 shrink truncate font-sans text-xs font-medium text-muted-foreground">
						{label}
					</Text>
				</ChatDisclosureRow>
				<View class="h-px flex-1 bg-border" />
			</View>
			{() =>
				open() ? (
					<View class="mt-2 rounded-(--pilo-radius-lg) border border-border bg-muted/30 px-3 py-2">
						<ChatMarkdown class="text-muted-foreground" text={summary} />
					</View>
				) : null
			}
		</ConversationColumn>
	);
}
