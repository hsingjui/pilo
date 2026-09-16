import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type RefCallback,
	type RefObject,
} from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import type { VirtualizerHandle } from "virtua";

import {
	getChatScrollBottomPadding,
	scrollChatViewportToRealBottom,
	type ChatStickyScrollCorrectionMode,
} from "@/components/chat/chat-sticky-scroll-dom";
import { recordStickyScrollMetric } from "@/lib/chat-performance";

function getStickyScrollCorrectionMode(): ChatStickyScrollCorrectionMode {
	const mode = import.meta.env.VITE_PILO_STICKY_SCROLL_MODE;
	if (mode === "dom-only" || mode === "virtua-only" || mode === "none") {
		return mode;
	}
	return "baseline";
}

const STICKY_SCROLL_CORRECTION_MODE = getStickyScrollCorrectionMode();
const USE_PILO_RESIZE_OWNER =
	import.meta.env.VITE_PILO_STICKY_SCROLL_OWNER === "pilo";

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

	const stickToBottom = useStickToBottom({
		initial: initialSticky ? "instant" : false,
		resize: "instant",
	});
	const {
		contentRef,
		scrollRef: stickToBottomScrollRef,
		scrollToBottom: scrollToBottomWithLock,
		state,
		stopScroll,
	} = stickToBottom;
	const isSticky = state.isAtBottom;
	const stickyRef = useRef(isSticky);
	useLayoutEffect(() => {
		stickyRef.current = isSticky;
	}, [isSticky]);

	const scrollElementRef = useRef<HTMLDivElement | null>(null);
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
		null,
	);
	const scrollPositionRef = useRef(initialScrollTop);
	const initialScrollRestoredRef = useRef(false);
	const [initialScrollRestored, setInitialScrollRestored] = useState(false);
	const lastProgrammaticFollowAtRef = useRef(Number.NEGATIVE_INFINITY);

	const handleWheelUp = useCallback(
		(event: WheelEvent) => {
			if (event.deltaY < 0) stopScroll();
		},
		[stopScroll],
	);

	const setScrollRef = useCallback<RefCallback<HTMLDivElement>>(
		(nextScrollElement) => {
			const previousScrollElement = scrollElementRef.current;
			if (previousScrollElement === nextScrollElement) return;

			if (previousScrollElement) {
				previousScrollElement.removeEventListener("wheel", handleWheelUp);
			}
			contentRef(null);
			stickToBottomScrollRef(null);

			scrollElementRef.current = nextScrollElement;
			setScrollElement(nextScrollElement);
			if (!nextScrollElement) return;

			stickToBottomScrollRef(nextScrollElement);
			if (enabled) {
				const contentElement = nextScrollElement.firstElementChild;
				if (contentElement instanceof HTMLElement) {
					if (USE_PILO_RESIZE_OWNER) contentRef.current = contentElement;
					else contentRef(contentElement);
				}
			}
			nextScrollElement.addEventListener("wheel", handleWheelUp, {
				passive: true,
			});
		},
		[contentRef, enabled, handleWheelUp, stickToBottomScrollRef],
	);

	// Pilo keeps the scroll viewport mounted while loading/history states swap the
	// first child. Rebind the content observer when the Virtua surface appears.
	useLayoutEffect(() => {
		contentRef(null);
		if (!enabled) return;
		const contentElement = scrollElementRef.current?.firstElementChild;
		if (contentElement instanceof HTMLElement) {
			if (USE_PILO_RESIZE_OWNER) contentRef.current = contentElement;
			else contentRef(contentElement);
		}
	}, [contentRef, enabled]);

	const scrollToRealBottom = useCallback(() => {
		recordStickyScrollMetric("follow-request");
		const currentScrollElement = scrollElementRef.current;
		if (USE_PILO_RESIZE_OWNER) {
			// WebKit may dispatch the resulting scroll event synchronously. Mark
			// the write before touching scrollTop so the controller can recognize
			// this event as presentation follow rather than user navigation.
			lastProgrammaticFollowAtRef.current = performance.now();
		}
		const result = scrollChatViewportToRealBottom({
			itemCount: itemCountRef.current,
			vlist: vlistRef.current,
			scrollElement: currentScrollElement,
			bottomOffset: getChatScrollBottomPadding(currentScrollElement),
			mode: USE_PILO_RESIZE_OWNER
				? "dom-only"
				: STICKY_SCROLL_CORRECTION_MODE,
		});
		if (USE_PILO_RESIZE_OWNER && !result.domScrolled) {
			lastProgrammaticFollowAtRef.current = Number.NEGATIVE_INFINITY;
		}
		if (result.virtuaScrolled) recordStickyScrollMetric("virtua-scroll");
		if (result.domScrolled) recordStickyScrollMetric("dom-scroll-write");
	}, [vlistRef]);

	// Baseline: observe only while use-stick-to-bottom owns resize following.
	// Experiment: the same ResizeObserver becomes the single resize owner and
	// coalesces growth to at most one direct bottom clamp per animation frame.
	useEffect(() => {
		if (!enabled || itemCount === 0 || typeof ResizeObserver === "undefined") {
			return;
		}
		const contentElement = scrollElementRef.current?.firstElementChild;
		if (!(contentElement instanceof HTMLElement)) return;
		let previousHeight = contentElement.getBoundingClientRect().height;
		let frame: number | null = null;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { height } = entry.contentRect;
				if (height === previousHeight) continue;
				previousHeight = height;
				recordStickyScrollMetric("content-resize");
				if (
					!USE_PILO_RESIZE_OWNER ||
					!stickyRef.current ||
					itemCountRef.current <= 0 ||
					frame !== null
				) {
					continue;
				}
				frame = requestAnimationFrame(() => {
					frame = null;
					recordStickyScrollMetric("follow-frame");
					if (stickyRef.current) scrollToRealBottom();
				});
			}
		});
		observer.observe(contentElement);
		return () => {
			observer.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [enabled, itemCount, scrollToRealBottom]);

	useEffect(() => {
		if (!enabled || initialScrollRestoredRef.current || itemCount === 0) return;
		if (!vlistRef.current && !USE_PILO_RESIZE_OWNER) return;

		const initialState = initialStateRef.current;
		const frame = requestAnimationFrame(() => {
			recordStickyScrollMetric("follow-frame");
			const currentVlist = vlistRef.current;

			if (!initialState.sticky) {
				stopScroll();
				if (currentVlist) currentVlist.scrollTo(initialState.scrollTop);
				else if (scrollElementRef.current) {
					scrollElementRef.current.scrollTop = initialState.scrollTop;
				}
				scrollPositionRef.current = initialState.scrollTop;
			} else {
				void scrollToBottomWithLock({ animation: "instant" });
				scrollToRealBottom();
			}
			initialScrollRestoredRef.current = true;
			setInitialScrollRestored(true);
		});
		return () => cancelAnimationFrame(frame);
	}, [
		enabled,
		itemCount,
		scrollToBottomWithLock,
		scrollToRealBottom,
		stopScroll,
		vlistRef,
	]);

	// Background chats stay mounted. When a followed chat becomes visible again,
	// clamp it to the actual end after any hidden content growth.
	useEffect(() => {
		if (!enabled || !initialScrollRestored || !stickyRef.current) return;
		const frame = requestAnimationFrame(() => {
			recordStickyScrollMetric("follow-frame");
			scrollToRealBottom();
		});
		return () => cancelAnimationFrame(frame);
	}, [enabled, initialScrollRestored, scrollToRealBottom]);

	const scrollToBottom = useCallback(
		(smooth = false) => {
			if (itemCountRef.current <= 0) return;
			if (smooth) {
				const result = scrollToBottomWithLock({ animation: "smooth" });
				if (result instanceof Promise) {
					void result.then((atBottom) => {
						if (atBottom) scrollToRealBottom();
					});
				}
				return;
			}
			void scrollToBottomWithLock({ animation: "instant" });
			scrollToRealBottom();
		},
		[scrollToBottomWithLock, scrollToRealBottom],
	);

	const handleScroll = useCallback(
		(offset: number) => {
			const viewport = scrollElementRef.current;
			const scrollTop = viewport?.scrollTop ?? offset;
			scrollPositionRef.current = scrollTop;
			onScrollStateChangeRef.current?.({
				scrollTop,
				sticky: state.isAtBottom,
			});
			if (!USE_PILO_RESIZE_OWNER || !viewport) return false;
			const distanceFromBottom = Math.abs(
				viewport.scrollHeight - viewport.clientHeight - scrollTop,
			);
			return (
				distanceFromBottom <= 2 &&
				performance.now() - lastProgrammaticFollowAtRef.current <= 250
			);
		},
		[state],
	);

	const previousStickyRef = useRef(isSticky);
	useEffect(() => {
		if (previousStickyRef.current === isSticky) return;
		previousStickyRef.current = isSticky;
		onScrollStateChangeRef.current?.({
			scrollTop:
				scrollElementRef.current?.scrollTop ?? scrollPositionRef.current,
			sticky: isSticky,
		});
	}, [isSticky]);

	useEffect(
		() => () => {
			onScrollStateChangeRef.current?.({
				scrollTop:
					scrollElementRef.current?.scrollTop ?? scrollPositionRef.current,
				sticky: stickyRef.current,
			});
		},
		[],
	);

	// Keep a followed conversation pinned when the available viewport height
	// changes (window resize, composer resize, docked panels), without polling.
	useEffect(() => {
		if (!enabled || !scrollElement || typeof ResizeObserver === "undefined") {
			return;
		}
		let previousHeight = scrollElement.getBoundingClientRect().height;
		let frame: number | null = null;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { height } = entry.contentRect;
				if (height === previousHeight) continue;
				previousHeight = height;
				recordStickyScrollMetric("viewport-resize");
				if (!stickyRef.current || itemCountRef.current <= 0 || frame !== null) {
					continue;
				}
				frame = requestAnimationFrame(() => {
					frame = null;
					recordStickyScrollMetric("follow-frame");
					if (stickyRef.current) scrollToRealBottom();
				});
			}
		});
		observer.observe(scrollElement);
		return () => {
			observer.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [enabled, scrollElement, scrollToRealBottom]);

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
