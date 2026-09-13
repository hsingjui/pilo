import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { VirtualizerHandle } from "virtua";

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
	activeAssistantMessageId: string | null;
	effectiveLoadState: "ready" | "loading" | "error";
	initialScrollTop?: number;
	initialSticky?: boolean;
	onScrollStateChange?: (state: { scrollTop: number; sticky: boolean }) => void;
};

export function useChatScrollController({
	active,
	sessionId,
	messages,
	activeAssistantMessageId,
	effectiveLoadState,
	initialScrollTop = 0,
	initialSticky = true,
	onScrollStateChange,
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
	const itemOffsetDeltaRef = useRef(virtualPadding.start);
	const pendingOutlineJumpRef = useRef<{
		messageIndex: number;
		attempts: number;
	} | null>(null);
	const scrollSyncFrameRef = useRef<number | null>(null);
	const isScrolledFromTopRef = useRef(initialScrollTop > 16);
	const [isScrolledFromTop, setIsScrolledFromTop] = useState(
		initialScrollTop > 16,
	);
	const [activeOutlineIndex, setActiveOutlineIndex] = useState(
		outlineEntries.length ? outlineEntries.length - 1 : -1,
	);
	const activeOutlineIndexRef = useRef(activeOutlineIndex);
	activeOutlineIndexRef.current = activeOutlineIndex;

	const virtualized =
		active && effectiveLoadState === "ready" && messages.length > 0;
	const {
		scrollRef,
		scrollElement,
		scrollElementRef,
		isSticky,
		initialScrollRestored,
		handleScroll: handleStickyScroll,
		scrollToBottom,
		stopScroll,
	} = useChatStickyScroll({
		enabled: virtualized,
		vlistRef: virtualizerRef,
		itemCount: messages.length,
		initialScrollTop,
		initialSticky,
		onScrollStateChange,
	});
	recordChatPageRender(sessionId, messages.length, virtualized);

	const measureItemOffsetDelta = useCallback(() => {
		const viewport = scrollElementRef.current;
		const content = viewport?.firstElementChild;
		if (!viewport || !(content instanceof HTMLElement)) {
			itemOffsetDeltaRef.current = virtualPadding.start;
			return;
		}
		itemOffsetDeltaRef.current =
			content.getBoundingClientRect().top -
			viewport.getBoundingClientRect().top +
			viewport.scrollTop;
	}, [scrollElementRef, virtualPadding.start]);

	useLayoutEffect(() => {
		if (!virtualized) return;
		const viewport = scrollElementRef.current;
		if (!viewport) return;
		const measure = () => measureItemOffsetDelta();
		measure();
		const observer = new ResizeObserver(() => {
			requestAnimationFrame(measure);
		});
		observer.observe(viewport);
		return () => observer.disconnect();
	}, [measureItemOffsetDelta, scrollElementRef, virtualized]);

	const syncScrollState = useCallback(
		(offset?: number) => {
			recordScrollEvent();
			const viewport = scrollElementRef.current;
			if (!viewport) return;
			handleStickyScroll(offset ?? viewport.scrollTop);
			if (scrollSyncFrameRef.current !== null) return;

			scrollSyncFrameRef.current = requestAnimationFrame(() => {
				scrollSyncFrameRef.current = null;
				const currentViewport = scrollElementRef.current;
				if (!currentViewport) return;

				const vlist = virtualizerRef.current;
				const scrollOffset = vlist?.scrollOffset ?? currentViewport.scrollTop;
				const scrollSize = vlist?.scrollSize ?? currentViewport.scrollHeight;
				const viewportSize =
					vlist?.viewportSize ?? currentViewport.clientHeight;
				const nextScrolledFromTop = currentViewport.scrollTop > 16;
				if (isScrolledFromTopRef.current !== nextScrolledFromTop) {
					isScrolledFromTopRef.current = nextScrolledFromTop;
					setIsScrolledFromTop(nextScrolledFromTop);
				}

				if (vlist && messages.length > 0 && isChatPerformanceDebugEnabled()) {
					const relativeStart = Math.max(
						0,
						scrollOffset - itemOffsetDeltaRef.current,
					);
					const startIndex = vlist.findItemIndex(relativeStart);
					const endIndex = vlist.findItemIndex(relativeStart + viewportSize);
					recordVirtualChange({
						sync: true,
						startIndex,
						endIndex,
						totalSize: scrollSize,
					});
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
				const isAtEnd =
					maxScrollOffset > 0 && scrollOffset >= maxScrollOffset - 2;
				const readingOffset = Math.max(
					0,
					scrollOffset -
						itemOffsetDeltaRef.current +
						CHAT_OUTLINE_READING_OFFSET_PX,
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
		[handleStickyScroll, messages.length, outlineEntries, scrollElementRef],
	);

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
		virtualizerRef.current?.scrollToIndex(messageIndex, {
			align: "start",
			offset: itemOffsetDeltaRef.current,
		});
	}, []);

	const outlineJumpDrift = useCallback((messageIndex: number) => {
		const vlist = virtualizerRef.current;
		if (!vlist) return 0;
		return Math.abs(
			vlist.scrollOffset -
				itemOffsetDeltaRef.current -
				vlist.getItemOffset(messageIndex),
		);
	}, []);

	const handleOutlineJump = useCallback(
		(index: number) => {
			const entry = outlineEntries[index];
			if (!entry || !virtualizerRef.current) return;
			stopScroll();
			activeOutlineIndexRef.current = index;
			setActiveOutlineIndex(index);
			pendingOutlineJumpRef.current = {
				messageIndex: entry.messageIndex,
				attempts: 0,
			};
			scrollMessageToTop(entry.messageIndex);
			if (outlineJumpDrift(entry.messageIndex) <= OUTLINE_JUMP_TOLERANCE_PX) {
				pendingOutlineJumpRef.current = null;
			}
		},
		[outlineEntries, outlineJumpDrift, scrollMessageToTop, stopScroll],
	);

	const handleScrollEnd = useCallback(() => {
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
	}, [outlineJumpDrift, scrollMessageToTop]);

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
		initialScrollRestored,
		isScrolledFromTop,
		activeOutlineIndex,
		syncScrollState,
		scrollToBottom,
		handleOutlineJump,
		handleScrollEnd,
	};
}
