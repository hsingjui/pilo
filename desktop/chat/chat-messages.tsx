import {
	List,
	type ListRef,
	type ListSlot,
	type ScrollEvent,
	signal,
	Text,
	untracked,
	View,
	type ViewToken,
} from "nsh";

import { shouldShowChatScrollToLatest } from "@/lib/chat/chat-scroll-to-latest";
import type { ChatMessage } from "@/lib/chat/conversation-types";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { scrollbarLook } from "../ui/scrollbar";
import { Tooltip } from "../ui/tooltip";
import { ChatMessageRow } from "./chat-message-row";
import type {
	AssistantChatMessage,
	ChatMessageBody,
	UserChatMessage,
} from "./chat-message-types";
import { ConversationColumn } from "./conversation-column";

// How close to its end the list still counts as at the end, in points.
const followThreshold = 4;
// How far the list is scrolled before its top edge fades, in points.
const fadeAfter = 16;

/**
 * A row is its message's place in the chat. The reducer names a reply anew
 * each time the chat is read again, so a message's id does not last; its
 * place does, and a row kept by it stays measured and in place across reads.
 */
const rowKey = (_: ChatMessage, index: number) => String(index);

export interface ChatMessagesProps {
	messages: () => readonly ChatMessage[];
	userBody?: ChatMessageBody<UserChatMessage>;
	assistantBody?: ChatMessageBody<AssistantChatMessage>;
	footer?: ListSlot;
	/** The first and last rows on screen, as their places in the chat. */
	onVisibleRangeChange?: (startIndex: number, endIndex: number) => void;
}

/**
 * A chat's messages as rows of a native list, opened on the last one. At its
 * end the list follows a reply as it grows; scrolled up it keeps the rows on
 * screen where they are and offers the way back to the latest message.
 */
export function ChatMessages(props: ChatMessagesProps) {
	let list: ListRef | undefined;
	const away = signal(false);
	const scrolled = signal(false);
	const follow = ({ offset, contentSize, size }: ScrollEvent) => {
		away.set(
			shouldShowChatScrollToLatest(
				{
					clientHeight: size.height,
					scrollHeight: contentSize.height,
					scrollTop: offset.y,
				},
				untracked(away),
			),
		);
		scrolled.set(offset.y > fadeAfter);
	};
	let visible: { start: number; end: number } | undefined;
	const reportVisible = (info: { viewableItems: ViewToken<ChatMessage>[] }) => {
		let start = Number.POSITIVE_INFINITY;
		let end = 0;
		for (const token of info.viewableItems) {
			if (!token.isViewable) continue;
			if (token.index < start) start = token.index;
			if (token.index > end) end = token.index;
		}
		if (start === Number.POSITIVE_INFINITY) return;
		if (visible?.start === start && visible?.end === end) return;
		visible = { start, end };
		props.onVisibleRangeChange?.(start, end);
	};
	return (
		<View class="min-h-0 flex-1">
			<List
				testID="chat-messages"
				ref={(node) => (list = node)}
				class="min-h-0 flex-1"
				contentClass="pt-6 pb-10"
				each={props.messages()}
				keyExtractor={rowKey}
				estimatedItemSize={96}
				initialScrollAtEnd
				maintainVisibleContentPosition={{
					autoscrollToBottomThreshold: followThreshold,
				}}
				scrollbar={{ vertical: scrollbarLook() }}
				footer={props.footer}
				onScroll={follow}
				onViewableItemsChange={reportVisible}
			>
				{(message) => (
					<ChatMessageRow
						message={message}
						userBody={props.userBody}
						assistantBody={props.assistantBody}
					/>
				)}
			</List>
			{() =>
				scrolled() ? (
					<View class="pointer-events-none absolute inset-x-0 top-0 h-12 bg-linear-to-b from-background to-transparent" />
				) : null
			}
			{() =>
				away() ? (
					<View class="pointer-events-none absolute inset-x-0 bottom-6">
						<ConversationColumn class="items-end">
							<Button
								testID="chat-scroll-latest"
								variant="secondary"
								size="icon"
								class="pointer-events-auto size-8 rounded-full border border-border/70 shadow-md"
								accessibilityLabel={t("chat.scrollLatest")}
								tooltip={
									<Tooltip>
										<Text>{() => t("chat.scrollLatest")}</Text>
									</Tooltip>
								}
								onPress={() => list?.scrollToEnd({ animated: false })}
							>
								<Icon name="ArrowDown" />
							</Button>
						</ConversationColumn>
					</View>
				) : null
			}
		</View>
	);
}
