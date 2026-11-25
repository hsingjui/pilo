/**
 * Pure geometry helpers for synchronizing the mobile WebUI root (`#app`) with
 * the browser's Visual Viewport across iOS Safari, WKWebView, and Android browsers.
 *
 * Keeping `#app` locked to the visual viewport establishes a single source of
 * truth for keyboard avoidance and prevents double-lift races between layout
 * viewport resizes, Safari focus scrolling, and nsh's `keyboardFrame()`.
 */

export const PINCH_ZOOM_SCALE_THRESHOLD = 1.01;
export const VIEWPORT_EPSILON_PX = 1;
export const KEYBOARD_MIN_SHRINK_PX = 120;
export const KEYBOARD_MIN_SHRINK_RATIO = 0.2;

export interface MobileViewportMetrics {
	/** Layout viewport height (`window.innerHeight`). */
	innerHeight: number;
	/** Visual viewport height (`visualViewport.height`). */
	viewportHeight: number;
	/** Visual viewport top offset relative to the layout viewport (`visualViewport.offsetTop`). */
	offsetTop: number;
	/** Visual viewport pinch-zoom scale (`visualViewport.scale`). */
	scale: number;
	/** Host document scroll offset (`window.scrollY`). */
	scrollY?: number;
}

export interface MobileViewportLayout {
	/** Whether `#app` needs explicit inline `top`/`height` instead of CSS `inset: 0`. */
	override: boolean;
	/** Inline `top` in CSS px when `override` is true. */
	top: number;
	/** Inline `height` in CSS px when `override` is true. */
	height: number;
	/** True when the visual viewport shrank enough to indicate a software keyboard. */
	keyboardOpen: boolean;
	/** Clamped non-negative visual viewport offsetTop in CSS px. */
	offsetTop: number;
	/** True when returning to full viewport with stale document scroll to reset. */
	shouldResetScroll: boolean;
}

export function computeMobileViewportLayout(
	metrics: MobileViewportMetrics,
): MobileViewportLayout {
	const {
		innerHeight,
		viewportHeight,
		offsetTop,
		scale,
		scrollY = 0,
	} = metrics;
	if (
		!Number.isFinite(innerHeight) ||
		!Number.isFinite(viewportHeight) ||
		innerHeight <= 0 ||
		viewportHeight <= 0 ||
		(Number.isFinite(scale) && scale > PINCH_ZOOM_SCALE_THRESHOLD)
	) {
		return {
			override: false,
			top: 0,
			height: 0,
			keyboardOpen: false,
			offsetTop: 0,
			shouldResetScroll: false,
		};
	}

	const roundedInnerHeight = Math.max(0, Math.round(innerHeight));
	const roundedHeight = Math.max(0, Math.round(viewportHeight));
	const clampedOffsetTop = Math.max(
		0,
		Math.round(Number.isFinite(offsetTop) ? offsetTop : 0),
	);
	const heightDiff = Math.abs(roundedInnerHeight - roundedHeight);
	const override =
		heightDiff > VIEWPORT_EPSILON_PX || clampedOffsetTop > VIEWPORT_EPSILON_PX;

	if (!override) {
		return {
			override: false,
			top: 0,
			height: roundedInnerHeight,
			keyboardOpen: false,
			offsetTop: 0,
			shouldResetScroll: Number.isFinite(scrollY) && scrollY > 0,
		};
	}

	const shrink = Math.max(0, roundedInnerHeight - roundedHeight);
	const keyboardThreshold = Math.max(
		KEYBOARD_MIN_SHRINK_PX,
		Math.round(roundedInnerHeight * KEYBOARD_MIN_SHRINK_RATIO),
	);

	return {
		override: true,
		top: clampedOffsetTop,
		height: roundedHeight,
		keyboardOpen: shrink >= keyboardThreshold,
		offsetTop: clampedOffsetTop,
		shouldResetScroll: false,
	};
}

export function resolveMobileComposerBottomPadding(params: {
	managed: boolean;
	keyboardOpen: boolean;
	keyboardHeight: number;
	safeAreaBottom: number;
}): number {
	const safeBottom = Math.max(0, params.safeAreaBottom);
	if (params.managed) {
		if (params.keyboardOpen) return 8;
		return Math.max(16, safeBottom + 8);
	}
	if (params.keyboardHeight > 0) return params.keyboardHeight + 8;
	return Math.max(16, safeBottom + 8);
}

export function resolveMobileSafeAreaTop(params: {
	safeAreaTop: number;
	baselineTop: number;
	offsetTop: number;
}): number {
	const current = Math.max(0, params.safeAreaTop);
	if (params.offsetTop > VIEWPORT_EPSILON_PX) {
		return Math.max(current, Math.max(0, params.baselineTop));
	}
	return current;
}

export function resolveMobileSheetMaxHeight(viewportHeight: number): number {
	if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 320;
	const available = Math.max(160, Math.round(viewportHeight - 16));
	return Math.min(available, Math.max(320, Math.round(viewportHeight * 0.85)));
}
