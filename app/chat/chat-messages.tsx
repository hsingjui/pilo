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
	shouldShowChatScrollToLatest,
} from "@shared/chat/chat-scroll-to-latest";
import {
	createWebChatScrollFollower,
	type WebChatScrollCommand,
	type WebChatScrollMetrics,
	type WebChatWheelInput,
} from "@shared/chat/web-chat-scroll";
import {
	createConversationOutline,
	createSegmentedConversationOutline,
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

type WebChatDomNode = {
	parentElement?: WebChatDomNode | null;
	scrollHeight?: number;
	clientHeight?: number;
	scrollTop?: number;
};

type WebChatWheelEvent = WebChatWheelInput & {
	target?: WebChatDomNode | null;
};

type WebChatTouchEvent = {
	target?: WebChatDomNode | null;
	touches?: {
		length: number;
		[index: number]: { clientX: number; clientY: number };
	};
};

type WebChatFocusEvent = {
	target?: { tagName?: string } | null;
};

interface WebChatViewport extends ChatScrollElementLike {
	style: {
		setProperty(name: string, value: string): void;
		removeProperty(name: string): void;
	};
	contains?: (node: unknown) => boolean;
	querySelector(
		selector: string,
	): { getBoundingClientRect(): { height: number } } | null;
	addEventListener(type: "scroll", listener: () => void): void;
	addEventListener(
		type: "wheel",
		listener: (event: WebChatWheelEvent) => void,
		options: { passive: boolean },
	): void;
	addEventListener(
		type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
		listener: (event: WebChatTouchEvent) => void,
		options: { passive: boolean },
	): void;
	removeEventListener(type: "scroll", listener: () => void): void;
	removeEventListener(
		type: "wheel",
		listener: (event: WebChatWheelEvent) => void,
	): void;
	removeEventListener(
		type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
		listener: (event: WebChatTouchEvent) => void,
	): void;
}

function observeWebChatEnd(initiallyFollowing: boolean) {
	type HostVisualViewport = {
		height: number;
		addEventListener(type: "resize", listener: () => void): void;
		removeEventListener(type: "resize", listener: () => void): void;
	};
	type BrowserWindow = {
		parent?: BrowserWindow;
		performance?: { now(): number };
		visualViewport?: HostVisualViewport | null;
		getComputedStyle?: (element: unknown) => { overflowY?: string };
		document?: {
			querySelector(selector: string): WebChatViewport | null;
			addEventListener?: (
				type: "focusin",
				listener: (event: WebChatFocusEvent) => void,
			) => void;
			removeEventListener?: (
				type: "focusin",
				listener: (event: WebChatFocusEvent) => void,
			) => void;
		};
		requestAnimationFrame(callback: () => void): number;
		cancelAnimationFrame(frame: number): void;
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

	const nowMs = () => host.performance?.now() ?? Date.now();
	const readMetrics = (): WebChatScrollMetrics => ({
		clientHeight: viewport.clientHeight,
		scrollHeight: viewport.scrollHeight,
		scrollTop: viewport.scrollTop,
		contentHeight: content.getBoundingClientRect().height,
	});
	const applyCommand = (command: WebChatScrollCommand) => {
		if (command.scrollTop !== null) {
			viewport.scrollTop = command.scrollTop;
		}
	};

	const follower = createWebChatScrollFollower(
		readMetrics(),
		initiallyFollowing,
		followThreshold,
	);

	let restoreFrame: number | undefined;
	const cancelRestoreSync = () => {
		if (restoreFrame === undefined) return;
		host.cancelAnimationFrame(restoreFrame);
		restoreFrame = undefined;
	};

	const hasNestedVerticalScroll = (
		target: WebChatDomNode | null | undefined,
		direction: -1 | 1,
	) => {
		let node = target ?? null;
		while (node && node !== (viewport as unknown as WebChatDomNode)) {
			const scrollHeight = node.scrollHeight ?? 0;
			const clientHeight = node.clientHeight ?? 0;
			if (scrollHeight > clientHeight + 1) {
				const overflowY = host.getComputedStyle?.(node).overflowY;
				if (
					overflowY === "auto" ||
					overflowY === "scroll" ||
					overflowY === "overlay"
				) {
					const scrollTop = node.scrollTop ?? 0;
					if (direction < 0 && scrollTop > 0) return true;
					if (direction > 0 && scrollTop + clientHeight < scrollHeight - 1) {
						return true;
					}
				}
			}
			node = node.parentElement ?? null;
		}
		return false;
	};

	let touchTarget: WebChatDomNode | null = null;
	let lastTouchClientY: number | null = null;

	const readWheel = (event: WebChatWheelEvent) => {
		const direction = event.deltaY < 0 ? -1 : event.deltaY > 0 ? 1 : 0;
		if (
			direction !== 0 &&
			Math.abs(event.deltaX) <= Math.abs(event.deltaY) &&
			hasNestedVerticalScroll(event.target, direction)
		) {
			return;
		}
		cancelRestoreSync();
		follower.onWheel(event, readMetrics());
	};
	const readTouchStart = (event: WebChatTouchEvent) => {
		const touch = event.touches?.[0];
		if (!touch) return;
		touchTarget = event.target ?? null;
		lastTouchClientY = touch.clientY;
		cancelRestoreSync();
		follower.onTouchStart(touch.clientY, touch.clientX);
	};
	const readTouchMove = (event: WebChatTouchEvent) => {
		const touch = event.touches?.[0];
		if (!touch) return;
		const dy = lastTouchClientY === null ? 0 : touch.clientY - lastTouchClientY;
		lastTouchClientY = touch.clientY;
		if (dy !== 0) {
			// Finger moving down scrolls content up (-1); moving up scrolls down (+1).
			const direction = dy > 0 ? -1 : 1;
			if (hasNestedVerticalScroll(touchTarget ?? event.target, direction)) {
				return;
			}
		}
		follower.onTouchMove(touch.clientY, readMetrics(), touch.clientX);
	};
	const readTouchEnd = (event: WebChatTouchEvent) => {
		if ((event.touches?.length ?? 0) > 0) return;
		touchTarget = null;
		lastTouchClientY = null;
		follower.onTouchEnd(readMetrics());
	};
	const readScroll = () => {
		applyCommand(follower.onScroll(readMetrics(), nowMs()));
	};
	const resize = new host.ResizeObserver(() => {
		// Correct the rendered offset before paint, after nsh has applied its layout.
		applyCommand(follower.onResize(readMetrics(), nowMs()));
	});

	const visualViewport = host.visualViewport ?? null;
	let lastVisualViewportHeight = visualViewport?.height ?? 0;
	const readVisualViewportResize = () => {
		if (!visualViewport) return;
		const nextHeight = visualViewport.height;
		const shrank =
			lastVisualViewportHeight > 0 && nextHeight < lastVisualViewportHeight - 1;
		lastVisualViewportHeight = nextHeight;
		if (shrank) {
			applyCommand(
				follower.onViewportShrinkIntent(readMetrics(), nowMs(), true),
			);
		}
	};
	const readFocusIn = (event: WebChatFocusEvent) => {
		const target = event.target;
		const tag = target?.tagName?.toUpperCase();
		if (
			(tag === "TEXTAREA" || tag === "INPUT") &&
			(!viewport.contains || !viewport.contains(target))
		) {
			applyCommand(follower.onViewportShrinkIntent(readMetrics(), nowMs()));
		}
	};

	viewport.addEventListener("scroll", readScroll);
	viewport.addEventListener("wheel", readWheel, { passive: true });
	viewport.addEventListener("touchstart", readTouchStart, { passive: true });
	viewport.addEventListener("touchmove", readTouchMove, { passive: true });
	viewport.addEventListener("touchend", readTouchEnd, { passive: true });
	viewport.addEventListener("touchcancel", readTouchEnd, { passive: true });
	visualViewport?.addEventListener("resize", readVisualViewportResize);
	host.document?.addEventListener?.("focusin", readFocusIn);
	resize.observe(viewport);
	resize.observe(content);

	return {
		syncAfterRestore() {
			cancelRestoreSync();
			// Read the committed position even when restoring it emits no scroll event.
			restoreFrame = host.requestAnimationFrame(() => {
				restoreFrame = undefined;
				follower.syncRestoredPosition(readMetrics());
			});
		},
		pauseForDisclosure() {
			cancelRestoreSync();
			follower.pauseForDisclosure(readMetrics());
		},
		startScrollToEnd() {
			cancelRestoreSync();
			follower.startScrollToEnd(readMetrics());
		},
		setFollowing(value: boolean) {
			cancelRestoreSync();
			follower.setFollowing(value, readMetrics());
		},
		endScroll() {
			applyCommand(follower.onScrollEnd(readMetrics()));
		},
		setDragging(value: boolean) {
			cancelRestoreSync();
			follower.onDragChange(value, readMetrics());
		},
		disconnect() {
			cancelRestoreSync();
			resize.disconnect();
			viewport.style.removeProperty("overflow-anchor");
			viewport.removeEventListener("scroll", readScroll);
			viewport.removeEventListener("wheel", readWheel);
			viewport.removeEventListener("touchstart", readTouchStart);
			viewport.removeEventListener("touchmove", readTouchMove);
			viewport.removeEventListener("touchend", readTouchEnd);
			viewport.removeEventListener("touchcancel", readTouchEnd);
			visualViewport?.removeEventListener("resize", readVisualViewportResize);
			host.document?.removeEventListener?.("focusin", readFocusIn);
		},
	};
}

/**
 * A row is its message's place in the chat. The reducer names a reply anew
 * each time the chat is read again, so a message's id does not last; its
 * place does, and a row kept by it stays measured and in place across reads.
 */
const rowKey = (_: ChatMessage | number, index: number) => String(index);

/** Where a chat was read to: the row at the viewport's start and how far
 * past its start, as the list's `measureScrollPosition` gives them. */
export interface ChatScrollPosition {
	index: number;
	offset: number;
}

export interface ChatMessagesProps {
	/** Optional full message list when `liveMessages` is not provided. */
	messages?: () => readonly ChatMessage[];
	/** The immutable history prefix at the start of the conversation. */
	historyPrefix: () => readonly ChatMessage[];
	/**
	 * The live messages after `historyPrefix()`. When provided, list rows and the
	 * outline read directly from `(historyPrefix, liveMessages)` without joining
	 * both arrays on every streaming delta.
	 */
	liveMessages?: () => readonly ChatMessage[];
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
	const updateSegmentedOutline = createSegmentedConversationOutline();
	const liveMessages = props.liveMessages;
	const fallbackMessages = () => props.messages?.() ?? [];
	const outline = computed(() =>
		liveMessages
			? updateSegmentedOutline(
					props.historyPrefix(),
					liveMessages(),
					t("chat.untitledMessage"),
				)
			: updateOutline(
					fallbackMessages(),
					props.historyPrefix(),
					t("chat.untitledMessage"),
				),
	);
	const showOutline = computed(() => outline().length >= 2);
	const firstVisibleIndex = signal(restore?.index ?? 0);
	const atEnd = signal(restore === null);
	const followPaused = signal(false);
	const web = platform.os === "web";
	// Stable positional indices keep `List.each` identical while a reply streams
	// (avoiding both full-prefix array copies and per-delta list diffs on desktop
	// and preserving measured cells on web).
	const rowCount = computed(() =>
		liveMessages
			? props.historyPrefix().length + liveMessages().length
			: fallbackMessages().length,
	);
	const rows = computed(() =>
		Array.from({ length: rowCount() }, (_, index) => index),
	);
	const webEndAttached = signal(false);
	let webEnd: ReturnType<typeof observeWebChatEnd>;
	let userScrolledBeforeAttach = false;
	const disclose = (update: () => void) => {
		// Let details grow below the trigger instead of following the new end.
		batch(() => {
			if (webEnd) webEnd.pauseForDisclosure();
			else followPaused.set(true);
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
		if (stopped || webEnd) return;
		const paused = untracked(followPaused);
		webEnd = observeWebChatEnd(
			restore === null && !paused && !userScrolledBeforeAttach,
		);
		if (!webEnd) return;
		if (restore !== null && !restoring && !paused) webEnd.syncAfterRestore();
		// Don't apply the list's relative end correction on top of the DOM's.
		webEndAttached.set(true);
	};
	cleanup(() => {
		stopped = true;
		webEnd?.disconnect();
	});
	let visible: { start: number; end: number } | undefined;
	const reportVisible = (info: {
		viewableItems: ViewToken<ChatMessage | number>[];
	}) => {
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
			webEnd?.syncAfterRestore();
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
		<ChatDisclosureAction.Provider value={disclose}>
			<View class="min-h-0 flex-1">
				<List
					testID="chat-messages"
					ref={(node) => (list = node)}
					class="min-h-0 flex-1"
					contentClass="pt-6 pb-10"
					each={rows()}
					keyExtractor={rowKey}
					estimatedItemSize={96}
					initialScrollIndex={restore?.index}
					initialScrollAtEnd={restore === null}
					maintainVisibleContentPosition={
						webEndAttached() || followPaused() ? undefined : followEnd
					}
					bounces={false}
					scrollbar={scrollbarTheme({ vertical: scrollbarLook() })}
					footer={props.footer}
					onLayout={web ? attachWebEnd : undefined}
					onScroll={follow}
					onScrollDragStart={
						web
							? () => {
									if (webEnd) webEnd.setDragging(true);
									else userScrolledBeforeAttach = true;
								}
							: undefined
					}
					onScrollDragEnd={web ? () => webEnd?.setDragging(false) : undefined}
					onScrollEnd={() => {
						if (web) webEnd?.endScroll();
						keepPosition();
					}}
					onViewableItemsChange={reportVisible}
				>
					{(item, index) => {
						const message = computed<ChatMessage>((previous) => {
							const row = item();
							// Keep showing the last message until a removed cell is recycled.
							if (typeof row !== "number") return row;
							if (liveMessages) {
								const prefix = props.historyPrefix();
								if (row < prefix.length) return prefix[row] ?? previous!;
								return liveMessages()[row - prefix.length] ?? previous!;
							}
							return fallbackMessages()[row] ?? previous!;
						});
						return (
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
						);
					}}
				</List>
				<View
					class="pointer-events-none absolute inset-x-0 top-0 h-12 bg-linear-to-b from-background to-transparent"
					style={[
						tactileTransition("opacity"),
						{ opacity: scrolled() ? 1 : 0 },
					]}
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
										webEnd?.startScrollToEnd();
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
		</ChatDisclosureAction.Provider>
	);
}
