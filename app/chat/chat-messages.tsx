import {
	batch,
	cleanup,
	computed,
	createMotion,
	List,
	type ListRef,
	type ListSlot,
	platform,
	reduceMotion,
	type ScrollEvent,
	signal,
	Text,
	untracked,
	View,
	type ViewToken,
} from "nsh";

import {
	CHAT_FOLLOW_BOTTOM_THRESHOLD_PX,
	type ChatScrollElementLike,
	getChatScrollMaxOffset,
	shouldShowChatScrollToLatest,
} from "@shared/chat/chat-scroll-to-latest";
import {
	createConversationOutline,
	getOutlineIndexForVisibleRange,
} from "@shared/chat/conversation-outline";
import type { ChatMessage } from "@shared/chat/conversation-types";
import { t } from "../shell/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { MOTION, tactileTransition } from "../ui/motion";
import { scrollbarLook, scrollbarTheme } from "../ui/scrollbar";
import { Tooltip } from "../ui/tooltip";
import { ChatDisclosureAction, type ChatExpansion } from "./chat-expansion";
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
const followThreshold = CHAT_FOLLOW_BOTTOM_THRESHOLD_PX;
const followEnd = { autoscrollToBottomThreshold: followThreshold };
// How far the list is scrolled before its top edge fades, in points.
const fadeAfter = 16;

type WebChatWheelEvent = {
	deltaX: number;
	deltaY: number;
	ctrlKey: boolean;
	shiftKey: boolean;
};

interface WebChatViewport extends ChatScrollElementLike {
	style: {
		setProperty(name: string, value: string): void;
		removeProperty(name: string): void;
	};
	querySelector(
		selector: string,
	): { getBoundingClientRect(): { height: number } } | null;
	addEventListener(type: "scroll", listener: () => void): void;
	addEventListener(
		type: "wheel",
		listener: (event: WebChatWheelEvent) => void,
		options: { passive: boolean },
	): void;
	removeEventListener(type: "scroll", listener: () => void): void;
	removeEventListener(
		type: "wheel",
		listener: (event: WebChatWheelEvent) => void,
	): void;
}

function observeWebChatEnd(
	initiallyFollowing: boolean,
	onResumeFollowing: () => void,
) {
	type BrowserWindow = {
		parent?: BrowserWindow;
		document?: { querySelector(selector: string): WebChatViewport | null };
		ResizeObserver?: new (callback: () => void) => {
			observe(element: object): void;
			disconnect(): void;
		};
	};
	const realm = globalThis as unknown as BrowserWindow;
	const selector = '[data-testid="chat-messages"]';
	let host = realm;
	let viewport = realm.document?.querySelector(selector);
	// nsh runs app code in an iframe but renders the list in the host page.
	if (!viewport && realm.parent && realm.parent !== realm) {
		try {
			host = realm.parent;
			viewport = host.document?.querySelector(selector);
		} catch {
			return;
		}
	}
	// The nsh web host sizes this spacer to the virtual list's content extent.
	const content = viewport?.querySelector(":scope > .nsh-spacer");
	if (!viewport || !content || !host.ResizeObserver) return;

	// The virtual list already anchors rows above the viewport. The browser
	// must not also anchor to content pushed down by an open disclosure.
	viewport.style.setProperty("overflow-anchor", "none");
	let following = initiallyFollowing;
	let pausedForDisclosure = false;
	let dragging = false;
	let wheelingUp = false;
	let end = getChatScrollMaxOffset(viewport);
	let contentHeight = content.getBoundingClientRect().height;
	let lastOffset = viewport.scrollTop;
	const updateFollowing = (value: boolean) => {
		pausedForDisclosure = false;
		following = value;
		if (value) onResumeFollowing();
	};
	const readWheel = ({
		deltaX,
		deltaY,
		ctrlKey,
		shiftKey,
	}: WebChatWheelEvent) => {
		if (ctrlKey || (shiftKey && !deltaX) || Math.abs(deltaX) > Math.abs(deltaY))
			return;
		if (deltaY < 0 && viewport.scrollTop > 0) {
			// nsh doesn't report a scroll drag for wheel input; pause before layout can change.
			wheelingUp = true;
			updateFollowing(false);
		} else if (deltaY > 0) {
			wheelingUp = false;
			if (
				getChatScrollMaxOffset(viewport) - viewport.scrollTop <=
				followThreshold
			)
				updateFollowing(true);
		}
	};
	const readScroll = () => {
		const offset = viewport.scrollTop;
		// Resize and duplicate scroll reports must not resume following.
		if (getChatScrollMaxOffset(viewport) !== end || offset === lastOffset)
			return;
		lastOffset = offset;
		updateFollowing(!wheelingUp && end - offset <= followThreshold);
	};
	const resize = new host.ResizeObserver(() => {
		end = getChatScrollMaxOffset(viewport);
		const height = content.getBoundingClientRect().height;
		// The spacer may shrink even when the chat was too short to scroll.
		if (
			pausedForDisclosure &&
			height < contentHeight &&
			end - viewport.scrollTop <= followThreshold
		) {
			updateFollowing(true);
		}
		contentHeight = height;
		// Correct the rendered offset before paint, after nsh has applied its layout.
		if (following && !dragging && Math.abs(end - viewport.scrollTop) > 1) {
			viewport.scrollTop = end;
		}
		lastOffset = viewport.scrollTop;
	});
	viewport.addEventListener("scroll", readScroll);
	viewport.addEventListener("wheel", readWheel, { passive: true });
	resize.observe(viewport);
	resize.observe(content);
	return {
		pauseForDisclosure() {
			pausedForDisclosure ||= following;
			following = false;
			lastOffset = viewport.scrollTop;
		},
		setFollowing(value: boolean) {
			pausedForDisclosure = false;
			wheelingUp = false;
			following = value;
			lastOffset = viewport.scrollTop;
		},
		endWheel() {
			wheelingUp = false;
		},
		setDragging(value: boolean) {
			wheelingUp = false;
			dragging = value;
			updateFollowing(
				!value &&
					getChatScrollMaxOffset(viewport) - viewport.scrollTop <=
						followThreshold,
			);
		},
		disconnect() {
			resize.disconnect();
			viewport.style.removeProperty("overflow-anchor");
			viewport.removeEventListener("scroll", readScroll);
			viewport.removeEventListener("wheel", readWheel);
		},
	};
}

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
	/** The immutable history prefix at the start of `messages()`. */
	historyPrefix: () => readonly ChatMessage[];
	userBody?: ChatMessageBody<UserChatMessage>;
	assistantBody?: ChatMessageBody<AssistantChatMessage>;
	assistantText?: ChatTextBody;
	/** What the user opened and closed in this chat. */
	expansion?: ChatExpansion;
	preferences?: () => ChatWorkPreferences | undefined;
	footer?: ListSlot;
	/** Forks the session at an assistant message; absent where forking is off. */
	onForkAssistant?: (messageId: string) => void;
	/** Whether the current chat allows forking at assistant replies. */
	canForkAssistant?: () => boolean;
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
	isPlaceholderFailed?: (index: number) => boolean;
	onRetryPlaceholder?: (index: number) => void;
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
	const updateOutline = createConversationOutline();
	const outline = computed(() =>
		updateOutline(
			props.messages(),
			props.historyPrefix(),
			t("chat.untitledMessage"),
		),
	);
	const showOutline = computed(() => outline().length >= 2);
	const firstVisibleIndex = signal(restore?.index ?? 0);
	const atEnd = signal(restore === null);
	const followPaused = signal(false);
	const web = platform.os === "web";
	let webEnd: ReturnType<typeof observeWebChatEnd>;
	const disclose = (update: () => void) => {
		// Let details grow below the trigger instead of following the new end.
		webEnd?.pauseForDisclosure();
		batch(() => {
			followPaused.set(true);
			update();
		});
	};
	const activeOutline = computed(() =>
		getOutlineIndexForVisibleRange(outline(), firstVisibleIndex(), atEnd()),
	);
	const follow = ({ offset, contentSize, size }: ScrollEvent) => {
		const isAtEnd =
			contentSize.height - (offset.y + size.height) <= followThreshold;
		atEnd.set(isAtEnd);
		if (isAtEnd && !webEnd) followPaused.set(false);
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
	let measureAgain = false;
	let stopped = false;
	const savePosition = props.onScrollPositionChange;
	// Measure while the list is still mounted; a session switch can remove it at any time.
	const keepPosition = () => {
		if (stopped || !savePosition || !list) return;
		if (measuring) {
			measureAgain = true;
			return;
		}
		measuring = true;
		measureAgain = false;
		void list
			.measureScrollPosition()
			.then(
				(position) => {
					if (position) savePosition(position);
				},
				() => {},
			)
			.finally(() => {
				measuring = false;
				if (measureAgain) keepPosition();
			});
	};
	const attachWebEnd = () => {
		if (!stopped) {
			webEnd ??= observeWebChatEnd(
				untracked(atEnd) && !untracked(followPaused),
				() => followPaused.set(false),
			);
		}
	};
	cleanup(() => {
		stopped = true;
		webEnd?.disconnect();
	});
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
			webEnd?.setFollowing(false);
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
		webEnd?.setFollowing(false);
		list?.scrollToIndex({
			index: entry.messageIndex,
			viewPosition: 0,
			animated: !reduceMotion(),
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
				maintainVisibleContentPosition={followPaused() ? undefined : followEnd}
				bounces={false}
				scrollbar={scrollbarTheme({ vertical: scrollbarLook() })}
				footer={props.footer}
				onLayout={web ? attachWebEnd : undefined}
				onScroll={follow}
				onScrollDragStart={web ? () => webEnd?.setDragging(true) : undefined}
				onScrollDragEnd={web ? () => webEnd?.setDragging(false) : undefined}
				onScrollEnd={() => {
					if (web) webEnd?.endWheel();
					keepPosition();
				}}
				onViewableItemsChange={reportVisible}
			>
				{(message, index) => (
					<ChatDisclosureAction.Provider value={disclose}>
						<ChatMessageRow
							message={message}
							index={index}
							isPlaceholderFailed={props.isPlaceholderFailed}
							onRetryPlaceholder={props.onRetryPlaceholder}
							userBody={props.userBody}
							assistantBody={props.assistantBody}
							assistantText={props.assistantText}
							expansion={props.expansion}
							preferences={props.preferences}
							onForkAssistant={props.onForkAssistant}
							canForkAssistant={props.canForkAssistant}
							forkingMessageId={props.forkingMessageId}
							forkDisabled={props.forkDisabled}
						/>
					</ChatDisclosureAction.Provider>
				)}
			</List>
			<View
				class="pointer-events-none absolute inset-x-0 top-0 h-12 bg-linear-to-b from-background to-transparent"
				style={[tactileTransition("opacity"), { opacity: scrolled() ? 1 : 0 }]}
			/>
			{() =>
				showOutline() ? (
					<ConversationOutlineRail
						entries={outline}
						activeIndex={activeOutline}
						onJump={jumpToOutline}
					/>
				) : null
			}
			{() => {
				if (!away()) return null;
				const latestMotion = createMotion({
					enter: reduceMotion()
						? {
								keyframes: { opacity: [0, 1] },
								duration: 80,
								easing: MOTION.easing.standardTuple,
							}
						: {
								keyframes: {
									opacity: [0, 1],
									translateY: [8, 0],
									scale: [0.94, 1],
								},
								duration: MOTION.duration.surfaceIn,
								easing: MOTION.easing.standardTuple,
							},
				});
				cleanup(() => latestMotion.stop());
				return (
					<View
						class="pointer-events-none absolute inset-x-0 bottom-6"
						style={latestMotion.style}
					>
						<ConversationColumn class="items-end">
							<Button
								testID="chat-scroll-latest"
								variant="secondary"
								size="icon"
								class={`pointer-events-auto rounded-full border border-border/70 shadow-md ${
									platform.desktop ? "size-8" : "size-11"
								}`}
								accessibilityLabel={t("chat.scrollLatest")}
								tooltip={
									<Tooltip>
										<Text class="font-sans">
											{() => t("chat.scrollLatest")}
										</Text>
									</Tooltip>
								}
								onPress={() => {
									followPaused.set(false);
									webEnd?.setFollowing(true);
									list?.scrollToEnd({ animated: !reduceMotion() });
								}}
							>
								<Icon name="ArrowDown" />
							</Button>
						</ConversationColumn>
					</View>
				);
			}}
		</View>
	);
}
