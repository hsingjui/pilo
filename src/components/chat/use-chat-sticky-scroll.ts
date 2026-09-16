import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type RefCallback,
	type RefObject,
} from "react";
import type { VirtualizerHandle } from "virtua";

import { getChatScrollMaxOffset } from "@/components/chat/chat-sticky-scroll-dom";
import { recordStickyScrollMetric } from "@/lib/chat-performance";

const BOTTOM_THRESHOLD_PX = 4;
const SCROLL_WRITE_EPSILON_PX = 1;

type ScrollOwnership = "following" | "reading";

type ChatScrollState = {
	scrollTop: number;
	sticky: boolean;
};

type UseChatStickyScrollOptions = {
	enabled: boolean;
	vlistRef: RefObject<VirtualizerHandle | null>;
	itemCount: number;
	initialScrollTop: number;
	initialSticky: boolean;
	onScrollStateChange?: (state: ChatScrollState) => void;
};

/**
 * Owns bottom-following for the chat viewport.
 *
 * There is intentionally one resize owner. Content/viewport ResizeObserver
 * notifications are coalesced into one rAF and perform one direct DOM bottom
 * clamp. Virtua is only asked to find the final row for initial restoration;
 * streaming growth never bounces through both Virtua and DOM corrections.
 */
export function useChatStickyScroll({
	enabled,
	vlistRef,
	itemCount,
	initialScrollTop,
	initialSticky,
	onScrollStateChange,
}: UseChatStickyScrollOptions) {
	const initialStateRef = useRef({
		scrollTop: initialScrollTop,
		sticky: initialSticky,
	});
	const onScrollStateChangeRef = useRef(onScrollStateChange);
	const itemCountRef = useRef(itemCount);
	useLayoutEffect(() => {
		onScrollStateChangeRef.current = onScrollStateChange;
	}, [onScrollStateChange]);
	useLayoutEffect(() => {
		itemCountRef.current = itemCount;
	}, [itemCount]);

	const scrollElementRef = useRef<HTMLDivElement | null>(null);
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
		null,
	);
	const scrollPositionRef = useRef(initialScrollTop);
	const ownershipRef = useRef<ScrollOwnership>(
		initialSticky ? "following" : "reading",
	);
	const [isSticky, setIsSticky] = useState(initialSticky);
	const initialScrollRestoredRef = useRef(false);
	const [initialScrollRestored, setInitialScrollRestored] = useState(false);
	const followFrameRef = useRef<number | null>(null);
	const touchStartYRef = useRef<number | null>(null);

	const commitOwnership = useCallback((nextOwnership: ScrollOwnership) => {
		if (ownershipRef.current === nextOwnership) return;
		ownershipRef.current = nextOwnership;
		setIsSticky(nextOwnership === "following");
	}, []);

	const clampToBottom = useCallback(() => {
		const viewport = scrollElementRef.current;
		if (!viewport || itemCountRef.current <= 0) return false;
		recordStickyScrollMetric("follow-request");
		const target = getChatScrollMaxOffset(viewport);
		if (Math.abs(viewport.scrollTop - target) <= SCROLL_WRITE_EPSILON_PX) {
			return false;
		}
		viewport.scrollTop = target;
		scrollPositionRef.current = target;
		recordStickyScrollMetric("dom-scroll-write");
		return true;
	}, []);

	const scheduleFollow = useCallback(() => {
		if (ownershipRef.current !== "following" || itemCountRef.current <= 0)
			return;
		if (followFrameRef.current !== null) return;
		followFrameRef.current = requestAnimationFrame(() => {
			followFrameRef.current = null;
			recordStickyScrollMetric("follow-frame");
			if (ownershipRef.current === "following") clampToBottom();
		});
	}, [clampToBottom]);

	const stopScroll = useCallback(() => {
		commitOwnership("reading");
		const viewport = scrollElementRef.current;
		onScrollStateChangeRef.current?.({
			scrollTop: viewport?.scrollTop ?? scrollPositionRef.current,
			sticky: false,
		});
	}, [commitOwnership]);

	const handleWheel = useCallback(
		(event: WheelEvent) => {
			if (event.deltaY < 0) stopScroll();
		},
		[stopScroll],
	);
	const handleTouchStart = useCallback((event: TouchEvent) => {
		touchStartYRef.current = event.touches[0]?.clientY ?? null;
	}, []);
	const handleTouchMove = useCallback(
		(event: TouchEvent) => {
			const startY = touchStartYRef.current;
			const currentY = event.touches[0]?.clientY;
			if (startY === null || currentY === undefined) return;
			if (currentY - startY < 8) return;
			touchStartYRef.current = null;
			stopScroll();
		},
		[stopScroll],
	);
	const handleTouchEnd = useCallback(() => {
		touchStartYRef.current = null;
	}, []);
	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if (
				event.key === "ArrowUp" ||
				event.key === "PageUp" ||
				event.key === "Home"
			) {
				stopScroll();
			}
		},
		[stopScroll],
	);
	const handlePointerDown = useCallback(
		(event: PointerEvent) => {
			const viewport = scrollElementRef.current;
			if (!viewport || event.button !== 0) return;
			const scrollbarWidth = viewport.offsetWidth - viewport.clientWidth;
			if (scrollbarWidth <= 0) return;
			const rect = viewport.getBoundingClientRect();
			if (event.clientX >= rect.right - scrollbarWidth) stopScroll();
		},
		[stopScroll],
	);

	const setScrollRef = useCallback<RefCallback<HTMLDivElement>>(
		(nextScrollElement) => {
			const previous = scrollElementRef.current;
			if (previous === nextScrollElement) return;
			if (previous) {
				previous.removeEventListener("wheel", handleWheel);
				previous.removeEventListener("touchstart", handleTouchStart);
				previous.removeEventListener("touchmove", handleTouchMove);
				previous.removeEventListener("touchend", handleTouchEnd);
				previous.removeEventListener("touchcancel", handleTouchEnd);
				previous.removeEventListener("keydown", handleKeyDown);
				previous.removeEventListener("pointerdown", handlePointerDown);
			}
			scrollElementRef.current = nextScrollElement;
			setScrollElement(nextScrollElement);
			if (!nextScrollElement) return;
			nextScrollElement.addEventListener("wheel", handleWheel, {
				passive: true,
			});
			nextScrollElement.addEventListener("touchstart", handleTouchStart, {
				passive: true,
			});
			nextScrollElement.addEventListener("touchmove", handleTouchMove, {
				passive: true,
			});
			nextScrollElement.addEventListener("touchend", handleTouchEnd, {
				passive: true,
			});
			nextScrollElement.addEventListener("touchcancel", handleTouchEnd, {
				passive: true,
			});
			nextScrollElement.addEventListener("keydown", handleKeyDown, {
				passive: true,
			});
			nextScrollElement.addEventListener("pointerdown", handlePointerDown, {
				passive: true,
			});
		},
		[
			handleKeyDown,
			handlePointerDown,
			handleTouchEnd,
			handleTouchMove,
			handleTouchStart,
			handleWheel,
		],
	);

	// One ResizeObserver owns both content growth and viewport-size changes. A
	// burst of measurements can schedule at most one bottom clamp per frame.
	useEffect(() => {
		if (
			!enabled ||
			itemCount === 0 ||
			!scrollElement ||
			typeof ResizeObserver === "undefined"
		) {
			return;
		}
		const contentElement = scrollElement.firstElementChild;
		if (!(contentElement instanceof HTMLElement)) return;
		let viewportHeight = scrollElement.getBoundingClientRect().height;
		let contentHeight = contentElement.getBoundingClientRect().height;
		const observer = new ResizeObserver((entries) => {
			let verticalLayoutChanged = false;
			for (const entry of entries) {
				if (entry.target === scrollElement) {
					if (Math.abs(entry.contentRect.height - viewportHeight) < 0.5)
						continue;
					viewportHeight = entry.contentRect.height;
					recordStickyScrollMetric("viewport-resize");
				} else {
					if (Math.abs(entry.contentRect.height - contentHeight) < 0.5)
						continue;
					contentHeight = entry.contentRect.height;
					recordStickyScrollMetric("content-resize");
				}
				verticalLayoutChanged = true;
			}
			if (verticalLayoutChanged) scheduleFollow();
		});
		observer.observe(scrollElement);
		observer.observe(contentElement);
		return () => observer.disconnect();
	}, [enabled, itemCount, scheduleFollow, scrollElement]);

	useEffect(() => {
		if (!enabled || initialScrollRestoredRef.current || itemCount === 0) return;
		const initialState = initialStateRef.current;
		let secondFrame: number | null = null;
		const frame = requestAnimationFrame(() => {
			recordStickyScrollMetric("follow-frame");
			const viewport = scrollElementRef.current;
			if (!viewport) return;
			if (!initialState.sticky) {
				commitOwnership("reading");
				if (vlistRef.current) vlistRef.current.scrollTo(initialState.scrollTop);
				else viewport.scrollTop = initialState.scrollTop;
				scrollPositionRef.current = initialState.scrollTop;
			} else {
				commitOwnership("following");
				// A single index jump teaches a long virtualized history which end to
				// mount. Subsequent streaming growth is DOM-only.
				if (vlistRef.current && itemCountRef.current > 0) {
					vlistRef.current.scrollToIndex(itemCountRef.current - 1, {
						align: "end",
					});
					recordStickyScrollMetric("virtua-scroll");
				}
				secondFrame = requestAnimationFrame(() => {
					secondFrame = null;
					clampToBottom();
				});
			}
			initialScrollRestoredRef.current = true;
			setInitialScrollRestored(true);
		});
		return () => {
			cancelAnimationFrame(frame);
			if (secondFrame !== null) cancelAnimationFrame(secondFrame);
		};
	}, [clampToBottom, commitOwnership, enabled, itemCount, vlistRef]);

	// When a followed conversation becomes visible again, one frame is enough to
	// catch up with content that grew while its visual tree was inactive.
	useEffect(() => {
		if (
			!enabled ||
			!initialScrollRestored ||
			ownershipRef.current !== "following"
		) {
			return;
		}
		scheduleFollow();
	}, [enabled, initialScrollRestored, scheduleFollow]);

	const scrollToBottom = useCallback(
		(smooth = false) => {
			const viewport = scrollElementRef.current;
			if (!viewport || itemCountRef.current <= 0) return;
			commitOwnership("following");
			const target = getChatScrollMaxOffset(viewport);
			if (smooth) viewport.scrollTo({ top: target, behavior: "smooth" });
			else viewport.scrollTop = target;
			scrollPositionRef.current = target;
			recordStickyScrollMetric("follow-request");
			recordStickyScrollMetric("dom-scroll-write");
		},
		[commitOwnership],
	);

	const handleScroll = useCallback(
		(offset: number) => {
			const viewport = scrollElementRef.current;
			if (!viewport) return false;
			const scrollTop = viewport.scrollTop ?? offset;
			scrollPositionRef.current = scrollTop;
			const distanceFromBottom = Math.max(
				0,
				viewport.scrollHeight - viewport.clientHeight - scrollTop,
			);
			if (
				ownershipRef.current === "reading" &&
				distanceFromBottom <= BOTTOM_THRESHOLD_PX
			) {
				commitOwnership("following");
			}
			const following = ownershipRef.current === "following";
			onScrollStateChangeRef.current?.({ scrollTop, sticky: following });
			return following;
		},
		[commitOwnership],
	);

	useEffect(
		() => () => {
			if (followFrameRef.current !== null) {
				cancelAnimationFrame(followFrameRef.current);
				followFrameRef.current = null;
			}
			const viewport = scrollElementRef.current;
			onScrollStateChangeRef.current?.({
				scrollTop: viewport?.scrollTop ?? scrollPositionRef.current,
				sticky: ownershipRef.current === "following",
			});
		},
		[],
	);

	return {
		scrollRef: setScrollRef,
		scrollElement,
		scrollElementRef,
		isSticky,
		initialScrollRestored,
		handleScroll,
		scrollToBottom,
		stopScroll,
	};
}
