import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CacheSnapshot, VirtualizerHandle } from "virtua";

import { useChatStickyScroll } from "@/components/chat/use-chat-sticky-scroll";
import { useChatVirtualPadding } from "@/components/chat/use-chat-virtual-padding";
import {
	isChatPerformanceDebugEnabled,
	logChatPerformanceInstructions,
	recordChatPageRender,
	recordScrollEvent,
	recordVirtualChange,
} from "@/lib/chat-performance";
import { getOutlineIndexForScrollOffset } from "@/lib/chat-virtualization";
import { buildConversationOutline } from "@/lib/conversation-outline";
import type { ChatMessage } from "@/lib/conversation-types";

const CHAT_OUTLINE_READING_OFFSET_PX = 72;
const OUTLINE_JUMP_TOLERANCE_PX = 2;
const OUTLINE_JUMP_MAX_CORRECTIONS = 3;

type UseChatScrollControllerOptions = {
	active: boolean;
	sessionId: string;
	messages: ChatMessage[];
	virtualizerEnabled?: boolean;
	activeAssistantMessageId: string | null;
	effectiveLoadState: "ready" | "loading" | "error";
	initialScrollTop?: number;
	initialSticky?: boolean;
	onScrollStateChange?: (state: { scrollTop: number; sticky: boolean }) => void;
	onVisibleRangeChange?: (startIndex: number, endIndex: number) => void;
	onVirtualizerCacheChange?: (
		cache: CacheSnapshot,
		messageCount: number,
	) => void;
};

export function useChatScrollController({
	active,
	sessionId,
	messages,
	virtualizerEnabled = true,
	activeAssistantMessageId,
	effectiveLoadState,
	initialScrollTop = 0,
	initialSticky = true,
	onScrollStateChange,
	onVisibleRangeChange,
	onVirtualizerCacheChange,
}: UseChatScrollControllerOptions) {
	const outlineRevision = activeAssistantMessageId
		? `${messages.length}:${activeAssistantMessageId}`
		: messages;
	// During an active turn, outline text/weight may lag until structure changes or
	// the turn settles; this avoids rescanning the full conversation on every delta.
	/* oxlint-disable react-hooks/exhaustive-deps */
	const outlineEntries = useMemo(
		() => buildConversationOutline(messages),
		[outlineRevision],
	);
	/* oxlint-enable react-hooks/exhaustive-deps */

	const virtualizerRef = useRef<VirtualizerHandle>(null);
	const virtualPadding = useChatVirtualPadding();
	const pendingOutlineJumpRef = useRef<{
		messageIndex: number;
		attempts: number;
	} | null>(null);
	const scrollSyncFrameRef = useRef<number | null>(null);
	const visibleRangeRef = useRef<{ start: number; end: number } | null>(null);
	const lastVirtualizerCachePersistAtRef = useRef(0);
	const isScrolledFromTopRef = useRef(initialScrollTop > 16);
	const [isScrolledFromTop, setIsScrolledFromTop] = useState(
		initialScrollTop > 16,
	);
	const [activeOutlineIndex, setActiveOutlineIndex] = useState(
		outlineEntries.length ? outlineEntries.length - 1 : -1,
	);
	const activeOutlineIndexRef = useRef(activeOutlineIndex);
	activeOutlineIndexRef.current = activeOutlineIndex;

	const scrollEnabled =
		active && effectiveLoadState === "ready" && messages.length > 0;
	const scrollEnabledRef = useRef(scrollEnabled);
	scrollEnabledRef.current = scrollEnabled;
	const virtualized = scrollEnabled && virtualizerEnabled;
	const {
		scrollRef,
		scrollElement,
		scrollElementRef,
		isSticky,
		showScrollToLatest,
		initialScrollRestored,
		handleScroll: handleStickyScroll,
		scrollToBottom,
		stopScroll,
	} = useChatStickyScroll({
		enabled: scrollEnabled,
		vlistRef: virtualizerRef,
		itemCount: messages.length,
		contentRevision: virtualizerEnabled,
		initialScrollTop,
		initialSticky,
		onScrollStateChange,
	});
	recordChatPageRender(sessionId, messages.length, virtualized);

	const persistVirtualizerCache = useCallback(
		(force = false) => {
			if (!scrollEnabledRef.current) return;
			const vlist = virtualizerRef.current;
			if (!vlist || !onVirtualizerCacheChange || messages.length === 0) return;
			const now = performance.now();
			if (!force && now - lastVirtualizerCachePersistAtRef.current < 250)
				return;
			lastVirtualizerCachePersistAtRef.current = now;
			onVirtualizerCacheChange(vlist.cache, messages.length);
		},
		[messages.length, onVirtualizerCacheChange],
	);

	useEffect(() => {
		if (!virtualized || !initialScrollRestored) return;
		persistVirtualizerCache(true);
	}, [initialScrollRestored, persistVirtualizerCache, virtualized]);

	const syncScrollState = useCallback(
		(offset?: number, force = false) => {
			if (!scrollEnabledRef.current) return;
			const viewport = scrollElementRef.current;
			if (!viewport) return;
			const programmaticFollow = handleStickyScroll(
				offset ?? viewport.scrollTop,
			);
			// Bottom-follow scrolls are presentation work. Re-running virtual range,
			// cache and outline synchronization for every streaming resize just feeds
			// the layout loop. The explicit initial sync below is the only exception.
			if (programmaticFollow && !force) return;
			recordScrollEvent();
			if (scrollSyncFrameRef.current !== null) return;

			scrollSyncFrameRef.current = requestAnimationFrame(() => {
				scrollSyncFrameRef.current = null;
				if (!scrollEnabledRef.current) return;
				const currentViewport = scrollElementRef.current;
				if (!currentViewport) return;

				const vlist = virtualizerRef.current;
				if (vlist) persistVirtualizerCache();
				const scrollOffset = vlist?.scrollOffset ?? currentViewport.scrollTop;
				const scrollSize = vlist?.scrollSize ?? currentViewport.scrollHeight;
				const viewportSize =
					vlist?.viewportSize ?? currentViewport.clientHeight;
				const relativeScrollOffset = Math.max(
					0,
					scrollOffset - virtualPadding.start,
				);
				const nextScrolledFromTop = currentViewport.scrollTop > 16;
				if (isScrolledFromTopRef.current !== nextScrolledFromTop) {
					isScrolledFromTopRef.current = nextScrolledFromTop;
					setIsScrolledFromTop(nextScrolledFromTop);
				}

				if (vlist && messages.length > 0) {
					// Virtualizer owns the top inset through startMargin, so its public
					// lookup accepts the real scroll offset without another DOM-derived
					// correction layer here.
					const startIndex = vlist.findItemIndex(scrollOffset);
					const endIndex = vlist.findItemIndex(scrollOffset + viewportSize);
					const previousRange = visibleRangeRef.current;
					if (
						!previousRange ||
						previousRange.start !== startIndex ||
						previousRange.end !== endIndex
					) {
						visibleRangeRef.current = { start: startIndex, end: endIndex };
						onVisibleRangeChange?.(startIndex, endIndex);
					}
					if (isChatPerformanceDebugEnabled()) {
						recordVirtualChange({
							sync: true,
							startIndex,
							endIndex,
							totalSize: scrollSize,
						});
					}
				}

				if (outlineEntries.length === 0) {
					if (activeOutlineIndexRef.current !== -1) {
						activeOutlineIndexRef.current = -1;
						setActiveOutlineIndex(-1);
					}
					return;
				}
				if (!vlist) return;

				const maxScrollOffset = scrollSize - viewportSize;
				// startMargin is only an item-coordinate inset. Virtua scrollSize and
				// scrollOffset stay in the real scroll-container coordinate space.
				const isAtEnd =
					maxScrollOffset > 0 && scrollOffset >= maxScrollOffset - 2;
				const readingOffset = Math.max(
					0,
					relativeScrollOffset + CHAT_OUTLINE_READING_OFFSET_PX,
				);
				const nextIndex = getOutlineIndexForScrollOffset(
					outlineEntries,
					(messageIndex) => vlist.getItemOffset(messageIndex),
					readingOffset,
					isAtEnd,
				);
				if (activeOutlineIndexRef.current !== nextIndex) {
					activeOutlineIndexRef.current = nextIndex;
					setActiveOutlineIndex(nextIndex);
				}
			});
		},
		[
			handleStickyScroll,
			messages.length,
			outlineEntries,
			onVisibleRangeChange,
			persistVirtualizerCache,
			scrollElementRef,
			virtualPadding.start,
		],
	);

	useEffect(() => {
		if (!scrollEnabled || !initialScrollRestored) return;
		syncScrollState(undefined, true);
	}, [initialScrollRestored, scrollEnabled, syncScrollState]);

	useEffect(() => {
		logChatPerformanceInstructions();
	}, []);

	useEffect(
		() => () => {
			if (scrollSyncFrameRef.current !== null) {
				cancelAnimationFrame(scrollSyncFrameRef.current);
			}
		},
		[],
	);

	const scrollMessageToTop = useCallback((messageIndex: number) => {
		virtualizerRef.current?.scrollToIndex(messageIndex, { align: "start" });
	}, []);

	const outlineJumpDrift = useCallback(
		(messageIndex: number) => {
			const vlist = virtualizerRef.current;
			if (!vlist) return 0;
			return Math.abs(
				vlist.scrollOffset -
					virtualPadding.start -
					vlist.getItemOffset(messageIndex),
			);
		},
		[virtualPadding.start],
	);

	const jumpToMessageIndex = useCallback(
		(messageIndex: number) => {
			stopScroll();
			const vlist = virtualizerRef.current;
			if (!vlist) {
				// 短会话走普通文档流（无 Virtualizer），按消息元素直接定位。
				const viewport = scrollElementRef.current;
				const message = messages[messageIndex];
				if (!viewport || !message) return;
				const row = viewport.querySelector<HTMLElement>(
					`[data-message-id="${CSS.escape(message.id)}"]`,
				);
				const target = row?.firstElementChild as HTMLElement | null;
				if (!target) return;
				const viewportRect = viewport.getBoundingClientRect();
				viewport.scrollTop +=
					target.getBoundingClientRect().top -
					viewportRect.top -
					virtualPadding.start;
				return;
			}
			pendingOutlineJumpRef.current = { messageIndex, attempts: 0 };
			scrollMessageToTop(messageIndex);
			if (outlineJumpDrift(messageIndex) <= OUTLINE_JUMP_TOLERANCE_PX) {
				pendingOutlineJumpRef.current = null;
			}
		},
		[
			messages,
			outlineJumpDrift,
			scrollElementRef,
			scrollMessageToTop,
			stopScroll,
			virtualPadding.start,
		],
	);

	const handleOutlineJump = useCallback(
		(index: number) => {
			const entry = outlineEntries[index];
			if (!entry) return;
			activeOutlineIndexRef.current = index;
			setActiveOutlineIndex(index);
			jumpToMessageIndex(entry.messageIndex);
		},
		[jumpToMessageIndex, outlineEntries],
	);

	const handleScrollEnd = useCallback(() => {
		if (!scrollEnabledRef.current) return;
		persistVirtualizerCache(true);
		const pending = pendingOutlineJumpRef.current;
		if (!pending) return;
		if (
			outlineJumpDrift(pending.messageIndex) <= OUTLINE_JUMP_TOLERANCE_PX ||
			pending.attempts >= OUTLINE_JUMP_MAX_CORRECTIONS
		) {
			pendingOutlineJumpRef.current = null;
			return;
		}
		pendingOutlineJumpRef.current = {
			messageIndex: pending.messageIndex,
			attempts: pending.attempts + 1,
		};
		scrollMessageToTop(pending.messageIndex);
	}, [outlineJumpDrift, persistVirtualizerCache, scrollMessageToTop]);

	useEffect(() => {
		const viewport = scrollElement;
		if (!viewport) return;
		const abandonPendingOutlineJump = () => {
			pendingOutlineJumpRef.current = null;
		};
		const options = { passive: true } as const;
		viewport.addEventListener("wheel", abandonPendingOutlineJump, options);
		viewport.addEventListener("touchstart", abandonPendingOutlineJump, options);
		viewport.addEventListener("keydown", abandonPendingOutlineJump, options);
		return () => {
			viewport.removeEventListener("wheel", abandonPendingOutlineJump);
			viewport.removeEventListener("touchstart", abandonPendingOutlineJump);
			viewport.removeEventListener("keydown", abandonPendingOutlineJump);
		};
	}, [scrollElement]);

	return {
		outlineEntries,
		scrollRef,
		virtualizerRef,
		virtualPadding,
		isSticky,
		showScrollToLatest,
		initialScrollRestored,
		isScrolledFromTop,
		activeOutlineIndex,
		syncScrollState,
		scrollToBottom,
		handleOutlineJump,
		jumpToMessageIndex,
		handleScrollEnd,
	};
}
