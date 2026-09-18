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

import { CHAT_EXPANSION_TOGGLE_EVENT } from "@/components/chat/chat-expansion-anchor";
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
	contentRevision: boolean;
	initialScrollTop: number;
	initialSticky: boolean;
	onScrollStateChange?: (state: ChatScrollState) => void;
};

/**
 * Owns bottom-following for the chat viewport.
 *
 * There is intentionally one resize owner. Content/viewport ResizeObserver
 * notifications are coalesced into one rAF and perform one direct DOM bottom
 * clamp. Streaming growth never bounces through both Virtua and DOM
 * corrections.
 */
export function useChatStickyScroll({
	enabled,
	vlistRef,
	itemCount,
	contentRevision,
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
	const hasItems = itemCount > 0;
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
	const followVisibilityActiveRef = useRef(false);
	const contentRevisionRef = useRef(contentRevision);
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
	// Expanding a disclosure in the upper half is reading intent. Bottom clamping
	// on the following resize would drag the anchored trigger upward one frame
	// after the click, so yield ownership before that correction can run.
	const handleExpansionToggle = useCallback(() => {
		if (ownershipRef.current !== "following") return;
		stopScroll();
	}, [stopScroll]);

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
				previous.removeEventListener(
					CHAT_EXPANSION_TOGGLE_EVENT,
					handleExpansionToggle,
				);
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
			nextScrollElement.addEventListener(
				CHAT_EXPANSION_TOGGLE_EVENT,
				handleExpansionToggle,
			);
		},
		[
			handleExpansionToggle,
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
			!hasItems ||
			!scrollElement ||
			typeof ResizeObserver === "undefined"
		) {
			return;
		}
		const contentElement = scrollElement.firstElementChild;
		if (!(contentElement instanceof HTMLElement)) return;
		const observedContentRevision = contentRevision;
		// ResizeObserver always delivers an initial measurement after observe().
		// Use that asynchronous notification as the baseline instead of forcing
		// synchronous geometry reads while a conversation is mounting/switching.
		let viewportHeight: number | null = null;
		let contentHeight: number | null = null;
		const observer = new ResizeObserver((entries) => {
			if (observedContentRevision !== contentRevisionRef.current) return;
			let verticalLayoutChanged = false;
			for (const entry of entries) {
				if (entry.target === scrollElement) {
					if (viewportHeight === null) {
						viewportHeight = entry.contentRect.height;
						continue;
					}
					if (Math.abs(entry.contentRect.height - viewportHeight) < 0.5)
						continue;
					viewportHeight = entry.contentRect.height;
					recordStickyScrollMetric("viewport-resize");
				} else {
					if (contentHeight === null) {
						contentHeight = entry.contentRect.height;
						continue;
					}
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
	}, [contentRevision, enabled, hasItems, scheduleFollow, scrollElement]);

	useLayoutEffect(() => {
		if (!enabled || initialScrollRestoredRef.current || itemCount === 0) return;
		const initialState = initialStateRef.current;
		const viewport = scrollElementRef.current;
		if (!viewport) return;
		let correctionFrame: number | null = null;

		if (!initialState.sticky) {
			commitOwnership("reading");
			// Restore the native viewport synchronously before the first visible paint.
			// Virtua still receives the same imperative target so its internal store
			// converges with the DOM position once its initial measurements settle.
			viewport.scrollTop = initialState.scrollTop;
			vlistRef.current?.scrollTo(initialState.scrollTop);
			scrollPositionRef.current = initialState.scrollTop;
		} else {
			commitOwnership("following");
			// Do the first bottom clamp in layout phase so a newly selected history
			// never paints at scrollTop=0. Virtua is then primed with the final row and
			// one rAF correction handles any measurement delta without exposing the
			// old/top range as an intermediate frame.
			clampToBottom();
			if (vlistRef.current && itemCountRef.current > 0) {
				vlistRef.current.scrollToIndex(itemCountRef.current - 1, {
					align: "end",
				});
				recordStickyScrollMetric("virtua-scroll");
				correctionFrame = requestAnimationFrame(() => {
					correctionFrame = null;
					recordStickyScrollMetric("follow-frame");
					clampToBottom();
				});
			}
		}

		// Mark this visibility pass as already corrected. The re-activation effect
		// below should only schedule when a previously hidden viewport becomes
		// enabled again, not immediately after this initial restoration.
		followVisibilityActiveRef.current = true;
		initialScrollRestoredRef.current = true;
		setInitialScrollRestored(true);
		return () => {
			if (correctionFrame !== null) cancelAnimationFrame(correctionFrame);
		};
	}, [clampToBottom, commitOwnership, enabled, itemCount, vlistRef]);

	// Retained background viewports stay laid out (visibility:hidden rather than
	// display:none), so reading offsets survive natively. A followed conversation
	// only needs one bottom convergence when it becomes active again, including
	// content that may have grown while its subscriber was frozen.
	useEffect(() => {
		if (!initialScrollRestored) return;
		if (!enabled) {
			followVisibilityActiveRef.current = false;
			return;
		}
		if (followVisibilityActiveRef.current) return;
		followVisibilityActiveRef.current = true;
		if (ownershipRef.current === "following") scheduleFollow();
	}, [enabled, initialScrollRestored, scheduleFollow]);

	useEffect(() => {
		if (contentRevisionRef.current === contentRevision) return;
		contentRevisionRef.current = contentRevision;
		if (
			!enabled ||
			!initialScrollRestored ||
			ownershipRef.current !== "following"
		) {
			return;
		}
		// Switching between plain DOM and Virtua replaces the observed content
		// element without changing itemCount. Rebind above, then converge the new
		// geometry to bottom once on the next frame.
		scheduleFollow();
	}, [contentRevision, enabled, initialScrollRestored, scheduleFollow]);

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
