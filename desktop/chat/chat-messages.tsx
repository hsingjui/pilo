import {
	computed,
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
import {
	buildConversationOutline,
	getOutlineIndexForVisibleRange,
} from "@/lib/chat/conversation-outline";
import type { ChatMessage } from "@/lib/chat/conversation-types";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { scrollbarLook } from "../ui/scrollbar";
import { Tooltip } from "../ui/tooltip";
import type { ChatExpansion } from "./chat-expansion";
import { ChatMessageRow } from "./chat-message-row";
import { ConversationOutlineRail } from "./conversation-outline-rail";
import type {
	AssistantChatMessage,
	ChatMessageBody,
	ChatTextBody,
	ChatWorkPreferences,
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

/** Where a chat was read to: the row at the viewport's start and how far
 * past its start, as the list's `measureScrollPosition` gives them. */
export interface ChatScrollPosition {
	index: number;
	offset: number;
}

export interface ChatMessagesProps {
	messages: () => readonly ChatMessage[];
	userBody?: ChatMessageBody<UserChatMessage>;
	assistantBody?: ChatMessageBody<AssistantChatMessage>;
	assistantText?: ChatTextBody;
	/** What the user opened and closed in this chat. */
	expansion?: ChatExpansion;
	preferences?: () => ChatWorkPreferences | undefined;
	footer?: ListSlot;
	/** Forks the session at an assistant message; absent where forking is off. */
	onForkAssistant?: (messageId: string) => void;
	/** The assistant message a fork is running for. */
	forkingMessageId?: () => string | null;
	/** A turn in flight or a pending read disables forking. */
	forkDisabled?: () => boolean;
	/** The first and last rows on screen, as their places in the chat. */
	onVisibleRangeChange?: (startIndex: number, endIndex: number) => void;
	/** Where the chat was read to when it was open before; at its end without it. */
	restorePosition?: ChatScrollPosition | null;
	/** Where the chat is read to, kept as it scrolls. */
	onScrollPositionChange?: (position: ChatScrollPosition) => void;
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
	// A chat opened before comes back where it was read to: the row, from
	// `initialScrollIndex`, and its offset, from the first viewable report.
	const restore = props.restorePosition ?? null;
	let restoring = restore !== null;
	const outline = computed(() => buildConversationOutline(props.messages()));
	const showOutline = computed(() => outline().length >= 2);
	const firstVisibleIndex = signal(restore?.index ?? 0);
	const atEnd = signal(restore === null);
	const activeOutline = computed(() =>
		getOutlineIndexForVisibleRange(outline(), firstVisibleIndex(), atEnd()),
	);
	const follow = ({ offset, contentSize, size }: ScrollEvent) => {
		atEnd.set(contentSize.height - (offset.y + size.height) <= followThreshold);
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
		keepPosition();
	};
	let measuring = false;
	// The position is kept as the list scrolls, so the chat can be read to
	// the same place when it is opened again; one measure at a time, the
	// last of a run of scrolls winning.
	const keepPosition = () => {
		if (measuring || !props.onScrollPositionChange || list === undefined) {
			return;
		}
		measuring = true;
		void list
			.measureScrollPosition()
			.then((position) => {
				measuring = false;
				if (position) props.onScrollPositionChange?.(position);
			})
			.catch(() => {
				measuring = false;
			});
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
		if (restoring && restore !== null) {
			restoring = false;
			list?.scrollToIndex({
				index: restore.index,
				viewOffset: -restore.offset,
				animated: false,
			});
		}
		if (visible?.start === start && visible?.end === end) return;
		visible = { start, end };
		firstVisibleIndex.set(start);
		props.onVisibleRangeChange?.(start, end);
	};
	// Jump to the prompt, even if its row is still a placeholder. The visible
	// range report then asks the transcript store for that page.
	const jumpToOutline = (index: number) => {
		const entry = untracked(outline)[index];
		if (!entry) return;
		list?.scrollToIndex({
			index: entry.messageIndex,
			viewPosition: 0,
			animated: false,
		});
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
				initialScrollIndex={restore?.index}
				initialScrollAtEnd={restore === null}
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
						assistantText={props.assistantText}
						expansion={props.expansion}
						preferences={props.preferences}
						onForkAssistant={props.onForkAssistant}
						forkingMessageId={props.forkingMessageId}
						forkDisabled={props.forkDisabled}
					/>
				)}
			</List>
			{() =>
				scrolled() ? (
					<View class="pointer-events-none absolute inset-x-0 top-0 h-12 bg-linear-to-b from-background to-transparent" />
				) : null
			}
			{() =>
				showOutline() ? (
					<ConversationOutlineRail
						entries={outline}
						activeIndex={activeOutline}
						onJump={jumpToOutline}
					/>
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
										<Text class="font-sans">
											{() => t("chat.scrollLatest")}
										</Text>
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
