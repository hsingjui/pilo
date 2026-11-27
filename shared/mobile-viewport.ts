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
	/** Layout height before it shrank to fit the keyboard. */
	keyboardBaselineHeight?: number;
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
		keyboardBaselineHeight = 0,
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
	const roundedViewportHeight = Math.max(0, Math.round(viewportHeight));
	const referenceHeight = Math.max(
		roundedInnerHeight,
		Math.max(0, Math.round(keyboardBaselineHeight)),
	);
	const keyboardThreshold = Math.max(
		KEYBOARD_MIN_SHRINK_PX,
		Math.round(referenceHeight * KEYBOARD_MIN_SHRINK_RATIO),
	);
	// In Android WebView (`resizes-content`), `window.innerHeight` itself shrinks
	// to fit the keyboard. Once the layout viewport has already shrunk by a
	// keyboard height, ignore transient double-subtracted `visualViewport.height`
	// values and dismiss-time overshoots (`viewportHeight > innerHeight`).
	const layoutShrankForKeyboard =
		referenceHeight - roundedInnerHeight >= keyboardThreshold;
	// Never size `#app` taller than `innerHeight`: if `rect.bottom > innerHeight`,
	// nsh's `safeArea().bottom` (`env - (innerHeight - rect.bottom)`) spikes by
	// the overshoot and pushes the composer to the top of the screen.
	const fittedHeight = layoutShrankForKeyboard
		? roundedInnerHeight
		: Math.min(roundedInnerHeight, roundedViewportHeight);
	const rawOffsetTop = Math.max(
		0,
		Math.round(Number.isFinite(offsetTop) ? offsetTop : 0),
	);
	const maxOffsetTop = Math.max(0, roundedInnerHeight - fittedHeight);
	const clampedOffsetTop = Math.min(rawOffsetTop, maxOffsetTop);
	const heightDiff = roundedInnerHeight - fittedHeight;
	const override =
		heightDiff > VIEWPORT_EPSILON_PX || clampedOffsetTop > VIEWPORT_EPSILON_PX;
	const keyboardOpen = referenceHeight - fittedHeight >= keyboardThreshold;

	if (!override) {
		return {
			override: false,
			top: 0,
			height: roundedInnerHeight,
			keyboardOpen,
			offsetTop: 0,
			shouldResetScroll:
				!keyboardOpen && Number.isFinite(scrollY) && scrollY > 0,
		};
	}

	return {
		override: true,
		top: clampedOffsetTop,
		height: fittedHeight,
		keyboardOpen,
		offsetTop: clampedOffsetTop,
		shouldResetScroll: false,
	};
}

export function resolveKeyboardBaselineHeight(params: {
	previousBaseline: number;
	innerHeight: number;
	viewportHeight: number;
	widthChanged: boolean;
	editableFocused: boolean;
	keyboardWasOpen: boolean;
}): number {
	const roundedInner =
		Number.isFinite(params.innerHeight) && params.innerHeight > 0
			? Math.round(params.innerHeight)
			: 0;
	if (roundedInner <= 0) return 0;
	if (params.widthChanged) return roundedInner;

	const previous =
		Number.isFinite(params.previousBaseline) && params.previousBaseline > 0
			? Math.round(params.previousBaseline)
			: 0;
	if (previous <= 0 || roundedInner >= previous) return roundedInner;

	const roundedViewport =
		Number.isFinite(params.viewportHeight) && params.viewportHeight > 0
			? Math.round(params.viewportHeight)
			: roundedInner;
	if (
		!params.editableFocused &&
		!params.keyboardWasOpen &&
		Math.abs(roundedInner - roundedViewport) <= VIEWPORT_EPSILON_PX
	) {
		return roundedInner;
	}
	return previous;
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

/**
 * Guards against nsh's `safeArea().bottom` inflating by `(rect.bottom - innerHeight)`
 * during transient resize frames where `#app` briefly extends past `innerHeight`.
 */
export function resolveMobileSafeAreaBottom(params: {
	safeAreaBottom: number;
	baselineBottom: number;
	bottomOvershoot: number;
	keyboardOpen: boolean;
}): number {
	const current = Math.max(0, params.safeAreaBottom);
	const baseline = Math.max(0, params.baselineBottom);
	if (params.bottomOvershoot > VIEWPORT_EPSILON_PX) {
		return Math.min(
			baseline,
			Math.max(0, current - Math.round(params.bottomOvershoot)),
		);
	}
	if (params.keyboardOpen) {
		return Math.min(current, baseline);
	}
	if (current >= KEYBOARD_MIN_SHRINK_PX && baseline < KEYBOARD_MIN_SHRINK_PX) {
		return baseline;
	}
	return current;
}

export function resolveMobileSheetMaxHeight(viewportHeight: number): number {
	if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 320;
	const available = Math.max(160, Math.round(viewportHeight - 16));
	return Math.min(available, Math.max(320, Math.round(viewportHeight * 0.85)));
}
