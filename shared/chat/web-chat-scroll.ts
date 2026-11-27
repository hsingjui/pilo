import {
	CHAT_FOLLOW_BOTTOM_THRESHOLD_PX,
	type ChatScrollElementLike,
	getChatScrollMaxOffset,
} from "./chat-scroll-to-latest";

/**
 * Duration to keep bottom-follow pinned across multi-frame soft-keyboard
 * open transitions and browser focus-scroll adjustments.
 */
export const WEB_CHAT_VIEWPORT_SHRINK_PIN_MS = 450;

/**
 * Vertical touch delta (in CSS px) needed to infer upward vs downward scroll
 * intent from raw touch movement.
 */
const TOUCH_DIRECTION_SLOP_PX = 2;

export interface WebChatScrollMetrics extends ChatScrollElementLike {
	/** Rendered extent of the list's content spacer (`.nsh-spacer`). */
	contentHeight: number;
}

export interface WebChatWheelInput {
	deltaX: number;
	deltaY: number;
	ctrlKey: boolean;
	shiftKey: boolean;
}

export interface WebChatScrollCommand {
	/** Non-null when the DOM `scrollTop` should be clamped to this offset. */
	scrollTop: number | null;
}

export interface WebChatScrollFollower {
	isFollowing(): boolean;
	onWheel(wheel: WebChatWheelInput, metrics: WebChatScrollMetrics): void;
	onTouchStart(clientY: number, clientX?: number): void;
	onTouchMove(
		clientY: number,
		metrics: WebChatScrollMetrics,
		clientX?: number,
	): void;
	onTouchEnd(metrics: WebChatScrollMetrics): void;
	onDragChange(dragging: boolean, metrics: WebChatScrollMetrics): void;
	onScroll(metrics: WebChatScrollMetrics, nowMs: number): WebChatScrollCommand;
	onScrollEnd(metrics: WebChatScrollMetrics): WebChatScrollCommand;
	onResize(metrics: WebChatScrollMetrics, nowMs: number): WebChatScrollCommand;
	onViewportShrinkIntent(
		metrics: WebChatScrollMetrics,
		nowMs: number,
		visualViewportShrank?: boolean,
	): WebChatScrollCommand;
	syncRestoredPosition(metrics: WebChatScrollMetrics): void;
	pauseForDisclosure(metrics: WebChatScrollMetrics): void;
	startScrollToEnd(metrics: WebChatScrollMetrics): void;
	setFollowing(value: boolean, metrics: WebChatScrollMetrics): void;
}

/**
 * Pure state machine for Web chat auto-follow & soft-keyboard lift.
 *
 * Keeps reading ownership when the user scrolls up (wheel or touch), reliably
 * resumes following when the user scrolls or flicks back to the bottom (even
 * while streaming or virtualized row measurement changes `scrollHeight`), and
 * pushes the latest messages up above the composer when the viewport shrinks
 * for a mobile soft keyboard.
 */
export function createWebChatScrollFollower(
	initialMetrics: WebChatScrollMetrics,
	initiallyFollowing: boolean,
	threshold = CHAT_FOLLOW_BOTTOM_THRESHOLD_PX,
): WebChatScrollFollower {
	let following = initiallyFollowing;
	let pausedForDisclosure = false;
	let dragging = false;
	let touchActive = false;
	let touchMoved = false;
	let lastTouchX: number | null = null;
	let lastTouchY: number | null = null;
	let scrollingUp = false;
	let programmaticScrollToEnd = false;
	let viewportShrinkPinUntilMs = 0;

	let end = getChatScrollMaxOffset(initialMetrics);
	let viewportHeight = initialMetrics.clientHeight;
	let contentHeight = initialMetrics.contentHeight;
	let lastOffset = initialMetrics.scrollTop;

	const isNearEnd = (metrics: ChatScrollElementLike) =>
		getChatScrollMaxOffset(metrics) - metrics.scrollTop <= threshold;

	const isInteracting = () => dragging || touchActive;

	const updateFollowing = (value: boolean) => {
		pausedForDisclosure = false;
		following = value;
	};

	const clearUserPinOverrides = () => {
		programmaticScrollToEnd = false;
		viewportShrinkPinUntilMs = 0;
	};

	return {
		isFollowing() {
			return following;
		},

		onWheel(
			{ deltaX, deltaY, ctrlKey, shiftKey }: WebChatWheelInput,
			metrics: WebChatScrollMetrics,
		) {
			if (
				ctrlKey ||
				(shiftKey && !deltaX) ||
				Math.abs(deltaX) > Math.abs(deltaY)
			) {
				return;
			}
			if (deltaY < 0 && metrics.scrollTop > 0) {
				scrollingUp = true;
				clearUserPinOverrides();
				updateFollowing(false);
			} else if (deltaY > 0) {
				scrollingUp = false;
				if (isNearEnd(metrics)) updateFollowing(true);
			}
		},

		onTouchStart(clientY: number, clientX?: number) {
			touchActive = true;
			touchMoved = false;
			lastTouchX = clientX ?? null;
			lastTouchY = clientY;
			programmaticScrollToEnd = false;
		},

		onTouchMove(
			clientY: number,
			metrics: WebChatScrollMetrics,
			clientX?: number,
		) {
			if (!touchActive) {
				touchActive = true;
				touchMoved = false;
				lastTouchX = clientX ?? null;
				lastTouchY = clientY;
				return;
			}
			if (lastTouchY === null) {
				lastTouchX = clientX ?? null;
				lastTouchY = clientY;
				return;
			}
			const dy = clientY - lastTouchY;
			const dx =
				clientX !== undefined && lastTouchX !== null ? clientX - lastTouchX : 0;
			if (
				Math.abs(dy) < TOUCH_DIRECTION_SLOP_PX &&
				Math.abs(dx) < TOUCH_DIRECTION_SLOP_PX
			) {
				return;
			}
			// Ignore horizontal gestures (e.g. scrolling wide code blocks or tables).
			if (Math.abs(dx) > Math.abs(dy)) {
				lastTouchX = clientX ?? lastTouchX;
				lastTouchY = clientY;
				return;
			}
			touchMoved = true;
			if (clientX !== undefined) lastTouchX = clientX;
			lastTouchY = clientY;
			// Finger moving down drags older messages into view (scrolling up).
			if (dy > 0 && metrics.scrollTop > 0) {
				scrollingUp = true;
				clearUserPinOverrides();
				updateFollowing(false);
			} else if (dy < 0) {
				scrollingUp = false;
			}
		},

		onTouchEnd(metrics: WebChatScrollMetrics) {
			const didMove = touchMoved;
			touchActive = false;
			touchMoved = false;
			lastTouchX = null;
			lastTouchY = null;
			// Clear directional intent if the touch never started a drag/scroll,
			// so a minor finger jitter without a following `scrollEnd` cannot stick.
			if (!dragging && metrics.scrollTop === lastOffset) {
				scrollingUp = false;
			}
			// A plain tap fires `pointerup` (which may pause for a disclosure)
			// before `touchend`; only a real scroll gesture may resume following.
			if (
				didMove &&
				!dragging &&
				!scrollingUp &&
				!pausedForDisclosure &&
				isNearEnd(metrics)
			) {
				updateFollowing(true);
			}
			lastOffset = metrics.scrollTop;
		},

		onDragChange(value: boolean, metrics: WebChatScrollMetrics) {
			dragging = value;
			if (value) {
				clearUserPinOverrides();
				updateFollowing(false);
				lastOffset = metrics.scrollTop;
				return;
			}
			// Do not permanently lock out momentum scrolling; only mark following
			// now if already at the bottom, and let subsequent scroll/scrollEnd
			// restore following once a downward flick lands at the end.
			if (!touchActive && !scrollingUp && isNearEnd(metrics)) {
				updateFollowing(true);
			} else if (!touchActive && !isNearEnd(metrics)) {
				updateFollowing(false);
			}
			lastOffset = metrics.scrollTop;
		},

		onScroll(
			metrics: WebChatScrollMetrics,
			nowMs: number,
		): WebChatScrollCommand {
			const maxOffset = getChatScrollMaxOffset(metrics);
			const offset = metrics.scrollTop;
			const nearEnd = maxOffset - offset <= threshold;

			if (programmaticScrollToEnd) {
				lastOffset = offset;
				if (nearEnd) {
					programmaticScrollToEnd = false;
					updateFollowing(true);
				}
				return { scrollTop: null };
			}

			// Protect against stale/browser-focus scroll events while a mobile
			// keyboard is animating the viewport height down.
			if (
				nowMs <= viewportShrinkPinUntilMs &&
				following &&
				!isInteracting() &&
				!scrollingUp
			) {
				if (Math.abs(maxOffset - offset) > 1) {
					lastOffset = maxOffset;
					return { scrollTop: maxOffset };
				}
				lastOffset = offset;
				return { scrollTop: null };
			}

			const extentChanged = maxOffset !== end;
			if (offset === lastOffset) {
				return { scrollTop: null };
			}

			const scrolledDown = offset > lastOffset;
			const scrolledUp = offset < lastOffset;
			lastOffset = offset;

			if (extentChanged) {
				// During streaming or virtualized row measurement, `scrollHeight` can
				// advance before ResizeObserver updates `end`. Still honor explicit
				// user scroll-to-bottom and upward scroll-away so following never
				// deadlocks at `false`.
				if (scrolledDown && !scrollingUp && nearEnd) {
					updateFollowing(true);
				} else if (scrolledUp && !nearEnd && (isInteracting() || scrollingUp)) {
					updateFollowing(false);
				}
				return { scrollTop: null };
			}

			if (pausedForDisclosure) {
				if (scrolledDown && !scrollingUp && nearEnd) {
					updateFollowing(true);
				}
				return { scrollTop: null };
			}

			updateFollowing(!scrollingUp && nearEnd);
			return { scrollTop: null };
		},

		onScrollEnd(metrics: WebChatScrollMetrics): WebChatScrollCommand {
			const wasProgrammaticScrollToEnd = programmaticScrollToEnd;
			scrollingUp = false;
			programmaticScrollToEnd = false;
			const maxOffset = getChatScrollMaxOffset(metrics);
			if (
				wasProgrammaticScrollToEnd &&
				following &&
				!isInteracting() &&
				!pausedForDisclosure &&
				Math.abs(maxOffset - metrics.scrollTop) > 1
			) {
				end = maxOffset;
				viewportHeight = metrics.clientHeight;
				contentHeight = metrics.contentHeight;
				lastOffset = maxOffset;
				return { scrollTop: maxOffset };
			}
			if (!isInteracting() && !pausedForDisclosure && isNearEnd(metrics)) {
				updateFollowing(true);
			}
			lastOffset = metrics.scrollTop;
			return { scrollTop: null };
		},

		onResize(
			metrics: WebChatScrollMetrics,
			nowMs: number,
		): WebChatScrollCommand {
			const prevEnd = end;
			const prevViewportHeight = viewportHeight;
			const prevOffset = lastOffset;

			const nextEnd = getChatScrollMaxOffset(metrics);
			const viewportShrank =
				prevViewportHeight > 0 && metrics.clientHeight < prevViewportHeight - 1;

			// A finished reply can fold its live work and clamp the list to the
			// new end without a user scroll. Restore following before the next resize.
			if (
				metrics.contentHeight < contentHeight &&
				!isInteracting() &&
				!scrollingUp &&
				isNearEnd(metrics)
			) {
				updateFollowing(true);
			}

			// When the viewport shrinks (soft keyboard opening, composer growing,
			// banner appearing), keep the latest messages pushed up if the user was
			// already at the bottom before the shrink.
			if (
				viewportShrank &&
				!isInteracting() &&
				!scrollingUp &&
				!pausedForDisclosure
			) {
				const wasNearPrevEnd =
					prevEnd - Math.max(metrics.scrollTop, prevOffset) <= threshold;
				if (following || wasNearPrevEnd || nowMs <= viewportShrinkPinUntilMs) {
					updateFollowing(true);
					viewportShrinkPinUntilMs = Math.max(
						viewportShrinkPinUntilMs,
						nowMs + 300,
					);
				}
			}

			end = nextEnd;
			viewportHeight = metrics.clientHeight;
			contentHeight = metrics.contentHeight;

			if (
				following &&
				!isInteracting() &&
				!programmaticScrollToEnd &&
				Math.abs(nextEnd - metrics.scrollTop) > 1
			) {
				lastOffset = nextEnd;
				return { scrollTop: nextEnd };
			}

			lastOffset = metrics.scrollTop;
			return { scrollTop: null };
		},

		onViewportShrinkIntent(
			metrics: WebChatScrollMetrics,
			nowMs: number,
			visualViewportShrank = false,
		): WebChatScrollCommand {
			if (isInteracting() || scrollingUp) return { scrollTop: null };
			const maxOffset = getChatScrollMaxOffset(metrics);
			// A browser can report the keyboard resize before the list's observer.
			// In that case the last scroll offset still belongs to the old viewport.
			const wasNearEndBeforeShrink =
				metrics.clientHeight < viewportHeight - 1 &&
				metrics.contentHeight <= contentHeight &&
				end - lastOffset <= threshold;
			// Focus alone does not override an explicit disclosure pause.
			if (
				pausedForDisclosure &&
				!visualViewportShrank &&
				!wasNearEndBeforeShrink
			) {
				return { scrollTop: null };
			}
			const wasAtEnd =
				maxOffset - metrics.scrollTop <= threshold ||
				wasNearEndBeforeShrink ||
				(!pausedForDisclosure &&
					(following || end - metrics.scrollTop <= threshold));
			if (!wasAtEnd) return { scrollTop: null };

			updateFollowing(true);
			viewportShrinkPinUntilMs = Math.max(
				viewportShrinkPinUntilMs,
				nowMs + WEB_CHAT_VIEWPORT_SHRINK_PIN_MS,
			);
			if (Math.abs(maxOffset - metrics.scrollTop) > 1) {
				lastOffset = maxOffset;
				return { scrollTop: maxOffset };
			}
			lastOffset = metrics.scrollTop;
			return { scrollTop: null };
		},

		syncRestoredPosition(metrics: WebChatScrollMetrics) {
			end = getChatScrollMaxOffset(metrics);
			viewportHeight = metrics.clientHeight;
			contentHeight = metrics.contentHeight;
			lastOffset = metrics.scrollTop;
			if (!isInteracting() && !scrollingUp && !pausedForDisclosure) {
				updateFollowing(isNearEnd(metrics));
			}
		},

		pauseForDisclosure(metrics: WebChatScrollMetrics) {
			clearUserPinOverrides();
			pausedForDisclosure ||= following;
			following = false;
			lastOffset = metrics.scrollTop;
		},

		startScrollToEnd(metrics: WebChatScrollMetrics) {
			scrollingUp = false;
			viewportShrinkPinUntilMs = 0;
			updateFollowing(true);
			programmaticScrollToEnd = !isNearEnd(metrics);
			lastOffset = metrics.scrollTop;
		},

		setFollowing(value: boolean, metrics: WebChatScrollMetrics) {
			scrollingUp = false;
			clearUserPinOverrides();
			updateFollowing(value);
			lastOffset = metrics.scrollTop;
		},
	};
}
