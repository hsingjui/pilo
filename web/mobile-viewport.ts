import {
	type Accessor,
	batch,
	cleanup,
	computed,
	context,
	effect,
	keyboardFrame,
	safeArea,
	signal,
	untracked,
	windowSize,
} from "nsh";

import {
	computeMobileViewportLayout,
	KEYBOARD_MIN_SHRINK_PX,
	resolveKeyboardBaselineHeight,
	resolveMobileSafeAreaBottom,
	resolveMobileSafeAreaTop,
	VIEWPORT_EPSILON_PX,
	type MobileViewportLayout,
} from "@shared/mobile-viewport";

const BLUR_SHRINK_HOLD_MS = 400;

export interface MobileViewportState {
	/** True when browser visualViewport sync owns `#app` geometry. */
	managed: Accessor<boolean>;
	/** Height available to content, without subtracting the keyboard twice. */
	availableHeight: Accessor<number>;
	/** Re-read the viewport on the next frame after returning from a native picker. */
	requestSync: () => void;
	/** True when the visual viewport shrank enough to indicate a software keyboard. */
	keyboardOpen: Accessor<boolean>;
	/** Current clamped visualViewport.offsetTop in CSS pixels. */
	offsetTop: Accessor<number>;
	/**
	 * Top safe-area inset that stays stable when iOS Safari scrolls
	 * `visualViewport.offsetTop` down while `#app` follows the visual viewport.
	 */
	safeAreaTop: Accessor<number>;
	/**
	 * Bottom safe-area inset guarded against transient `rect.bottom > innerHeight`
	 * overshoots when Android WebView or iOS Safari resizes layout and visual
	 * viewports on separate frames.
	 */
	safeAreaBottom: Accessor<number>;
}

const defaultMobileViewport: MobileViewportState = {
	managed: () => false,
	availableHeight: () =>
		Math.max(0, windowSize().height - keyboardFrame().height),
	requestSync: () => {},
	keyboardOpen: () => false,
	offsetTop: () => 0,
	safeAreaTop: () => safeArea().top,
	safeAreaBottom: () => safeArea().bottom,
};

export const MobileViewport = context<MobileViewportState>(
	defaultMobileViewport,
);

type HostVisualViewport = {
	height: number;
	offsetTop: number;
	scale: number;
	addEventListener(type: string, listener: () => void, capture: boolean): void;
	removeEventListener(
		type: string,
		listener: () => void,
		capture: boolean,
	): void;
};

type HostElement = {
	closest?(selector: string): HostElement | null;
};

type HostTouchPressEvent = {
	type: "pointerdown" | "touchend";
	pointerType?: string;
	cancelable: boolean;
	target: HostElement | null;
	preventDefault(): void;
};

type HostAppElement = {
	style: {
		top: string;
		bottom: string;
		height: string;
	};
	getBoundingClientRect?(): { bottom: number };
	addEventListener(
		type: HostTouchPressEvent["type"],
		listener: (event: HostTouchPressEvent) => void,
		options: { capture: boolean; passive: boolean },
	): void;
	removeEventListener(
		type: HostTouchPressEvent["type"],
		listener: (event: HostTouchPressEvent) => void,
		capture: boolean,
	): void;
};

type HostWindow = {
	parent?: HostWindow;
	innerWidth?: number;
	innerHeight?: number;
	scrollY?: number;
	visualViewport?: HostVisualViewport | null;
	document?: {
		activeElement: HostElement | null;
		getElementById(id: string): HostAppElement | null;
		addEventListener(type: string, listener: () => void): void;
		removeEventListener(type: string, listener: () => void): void;
	};
	addEventListener?: (
		type: string,
		listener: () => void,
		capture?: boolean,
	) => void;
	removeEventListener?: (
		type: string,
		listener: () => void,
		capture?: boolean,
	) => void;
	requestAnimationFrame?: (callback: () => void) => number;
	cancelAnimationFrame?: (handle: number) => void;
	scrollTo?: (x: number, y: number) => void;
};

function resolveHostAppTarget(): {
	host: HostWindow;
	viewport: HostVisualViewport;
	app: HostAppElement;
} | null {
	const globalWindow = globalThis as unknown as HostWindow;
	const candidates: HostWindow[] = [];
	try {
		if (globalWindow.parent && globalWindow.parent !== globalWindow) {
			candidates.push(globalWindow.parent);
		}
	} catch {
		// Ignore cross-origin parent access errors.
	}
	candidates.push(globalWindow);

	for (const candidate of candidates) {
		try {
			const viewport = candidate.visualViewport;
			const app = candidate.document?.getElementById("app");
			if (viewport && app) {
				return { host: candidate, viewport, app };
			}
		} catch {
			// Ignore inaccessible window realms.
		}
	}
	return null;
}

/**
 * Synchronizes the host page's `#app` container with `visualViewport` so mobile
 * browsers (iOS Safari, WKWebView, Android Chrome/WebView) share one layout
 * geometry without competing with `keyboardFrame()` padding.
 */
export function installMobileViewportSync(): MobileViewportState {
	const target = resolveHostAppTarget();
	if (!target) return defaultMobileViewport;

	const { host, viewport, app } = target;
	const height = signal(0);
	const keyboardOpen = signal(false);
	const offsetTop = signal(0);
	const baselineSafeAreaTop = signal(safeArea().top);
	const baselineSafeAreaBottom = signal(
		safeArea().bottom < KEYBOARD_MIN_SHRINK_PX ? safeArea().bottom : 0,
	);
	let lastBaselineWidth = windowSize().width;

	const measureBottomOvershoot = () => {
		const innerHeight = host.innerHeight ?? 0;
		const rectBottom = app.getBoundingClientRect?.().bottom;
		if (innerHeight <= 0 || rectBottom === undefined) return 0;
		return Math.max(0, Math.round(rectBottom - innerHeight));
	};

	effect(() => {
		const width = windowSize().width;
		const { top, bottom } = safeArea();
		const currentOffsetTop = offsetTop();
		const isKeyboardOpen = keyboardOpen();
		if (width !== lastBaselineWidth) {
			lastBaselineWidth = width;
			untracked(() => {
				baselineSafeAreaTop.set(top);
				const overshoot = bottom > 0 ? measureBottomOvershoot() : 0;
				const cleanBottom = Math.max(0, bottom - overshoot);
				if (cleanBottom < KEYBOARD_MIN_SHRINK_PX) {
					baselineSafeAreaBottom.set(cleanBottom);
				}
			});
			return;
		}
		if (currentOffsetTop <= VIEWPORT_EPSILON_PX) {
			untracked(() => baselineSafeAreaTop.set(top));
		}
		if (!isKeyboardOpen) {
			const prevBottom = untracked(baselineSafeAreaBottom);
			const overshoot = bottom > prevBottom ? measureBottomOvershoot() : 0;
			const cleanBottom = Math.max(0, bottom - overshoot);
			if (
				overshoot <= VIEWPORT_EPSILON_PX &&
				cleanBottom < KEYBOARD_MIN_SHRINK_PX
			) {
				untracked(() => baselineSafeAreaBottom.set(cleanBottom));
			}
		}
	});

	const safeAreaTop = computed(() =>
		resolveMobileSafeAreaTop({
			safeAreaTop: safeArea().top,
			baselineTop: baselineSafeAreaTop(),
			offsetTop: offsetTop(),
		}),
	);

	const safeAreaBottom = computed(() => {
		const current = safeArea().bottom;
		const baseline = baselineSafeAreaBottom();
		const overshoot = current > baseline ? measureBottomOvershoot() : 0;
		return resolveMobileSafeAreaBottom({
			safeAreaBottom: current,
			baselineBottom: baseline,
			bottomOvershoot: overshoot,
			keyboardOpen: keyboardOpen(),
		});
	});

	let appliedKey = "default";
	let appliedLayout: MobileViewportLayout | undefined;
	let pendingFrame: number | null = null;
	let blurShrinkHoldUntil: number | null = null;
	let blurShrinkTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;
	let lastViewportWidth = host.innerWidth;
	let keyboardBaselineHeight = 0;

	const clearBlurShrinkHold = () => {
		blurShrinkHoldUntil = null;
		if (blurShrinkTimer !== null) {
			clearTimeout(blurShrinkTimer);
			blurShrinkTimer = null;
		}
	};

	const isEditableFocused = () =>
		Boolean(
			host.document?.activeElement?.closest?.(
				"textarea, input, [contenteditable]",
			),
		);

	const applyLayout = (layout: MobileViewportLayout) => {
		appliedLayout = layout;
		const nextKey = layout.override
			? `${layout.top}:${layout.height}`
			: "default";
		if (nextKey !== appliedKey) {
			appliedKey = nextKey;
			if (layout.override) {
				app.style.top = `${layout.top}px`;
				app.style.bottom = "auto";
				app.style.height = `${layout.height}px`;
			} else {
				app.style.top = "";
				app.style.bottom = "";
				app.style.height = "";
			}
		}
		if (layout.shouldResetScroll) {
			try {
				host.scrollTo?.(0, 0);
			} catch {
				// Ignore scroll reset errors in restricted contexts.
			}
		}
		batch(() => {
			height.set(layout.height);
			keyboardOpen.set(layout.keyboardOpen);
			offsetTop.set(layout.offsetTop);
		});
	};

	const sync = (): void => {
		const { innerWidth, innerHeight = 0, scrollY = 0 } = host;
		const widthChanged = innerWidth !== lastViewportWidth;
		if (widthChanged) {
			lastViewportWidth = innerWidth;
			clearBlurShrinkHold();
		}
		const editableFocused = isEditableFocused();
		if (editableFocused) clearBlurShrinkHold();

		keyboardBaselineHeight = resolveKeyboardBaselineHeight({
			previousBaseline: keyboardBaselineHeight,
			innerHeight,
			viewportHeight: viewport.height,
			widthChanged,
			editableFocused,
			keyboardWasOpen: Boolean(appliedLayout?.keyboardOpen),
		});

		const layout = computeMobileViewportLayout({
			innerHeight,
			keyboardBaselineHeight,
			viewportHeight: viewport.height,
			offsetTop: viewport.offsetTop,
			scale: viewport.scale,
			scrollY,
		});

		// While dismissing the keyboard after blur, ignore transient further
		// shrinks (e.g. Android WebView IME animation glitches) for a bounded
		// window so `#app` never collapses to a thin strip at the top.
		if (
			!widthChanged &&
			!editableFocused &&
			appliedLayout?.keyboardOpen &&
			layout.height > 0 &&
			layout.height + VIEWPORT_EPSILON_PX < appliedLayout.height
		) {
			const now = Date.now();
			if (blurShrinkHoldUntil === null) {
				blurShrinkHoldUntil = now + BLUR_SHRINK_HOLD_MS;
				blurShrinkTimer = setTimeout(() => {
					blurShrinkTimer = null;
					if (!disposed) sync();
				}, BLUR_SHRINK_HOLD_MS);
			}
			if (now < blurShrinkHoldUntil) {
				const roundedInner = Math.max(0, Math.round(innerHeight));
				const heldHeight =
					roundedInner > 0
						? Math.min(appliedLayout.height, roundedInner)
						: appliedLayout.height;
				const heldTop =
					roundedInner > 0
						? Math.min(
								appliedLayout.top,
								Math.max(0, roundedInner - heldHeight),
							)
						: appliedLayout.top;
				const heldOverride =
					roundedInner <= 0 ||
					roundedInner - heldHeight > VIEWPORT_EPSILON_PX ||
					heldTop > VIEWPORT_EPSILON_PX;
				applyLayout({
					...appliedLayout,
					override: heldOverride,
					top: heldOverride ? heldTop : 0,
					height: heldOverride ? heldHeight : roundedInner,
					offsetTop: heldOverride ? heldTop : 0,
					shouldResetScroll: false,
				});
				return;
			}
		}

		clearBlurShrinkHold();
		if (!layout.keyboardOpen && !editableFocused && !layout.override) {
			keyboardBaselineHeight = layout.height;
		}
		applyLayout(layout);
	};

	const scheduleSync = () => {
		if (disposed || pendingFrame !== null) return;
		if (typeof host.requestAnimationFrame === "function") {
			pendingFrame = host.requestAnimationFrame(() => {
				pendingFrame = null;
				sync();
			});
			return;
		}
		sync();
	};

	const keepComposerFocus = (event: HostTouchPressEvent) => {
		if (!event.cancelable) return;
		if (event.type === "pointerdown" && event.pointerType === "mouse") return;
		if (
			event.target?.closest?.(
				'[data-testid="chat-scroll-latest"], [data-testid="chat-composer-send"]',
			) &&
			host.document?.activeElement?.closest?.(
				'[data-testid="mobile-textarea-input"]',
			)
		) {
			// Keep native tap focus changes out of the way; nsh presses on pointerup.
			event.preventDefault();
		}
	};
	const touchCapture = { capture: true, passive: false };
	app.addEventListener("pointerdown", keepComposerFocus, touchCapture);
	// Some iOS WebKit versions still synthesize mouse events after a canceled pointerdown.
	app.addEventListener("touchend", keepComposerFocus, touchCapture);

	sync();
	// Update #app before nsh measures its insets. Offset-only changes don't
	// trigger the host's ResizeObserver, so it must read the new position here.
	viewport.addEventListener("resize", sync, true);
	viewport.addEventListener("scroll", sync, true);
	host.addEventListener?.("resize", sync, true);
	host.addEventListener?.("orientationchange", scheduleSync);
	host.document?.addEventListener("focusin", scheduleSync);
	host.document?.addEventListener("focusout", scheduleSync);

	cleanup(() => {
		disposed = true;
		clearBlurShrinkHold();
		if (pendingFrame !== null) {
			host.cancelAnimationFrame?.(pendingFrame);
			pendingFrame = null;
		}
		viewport.removeEventListener("resize", sync, true);
		viewport.removeEventListener("scroll", sync, true);
		host.removeEventListener?.("resize", sync, true);
		host.removeEventListener?.("orientationchange", scheduleSync);
		host.document?.removeEventListener("focusin", scheduleSync);
		host.document?.removeEventListener("focusout", scheduleSync);
		app.removeEventListener("pointerdown", keepComposerFocus, true);
		app.removeEventListener("touchend", keepComposerFocus, true);
		app.style.top = "";
		app.style.bottom = "";
		app.style.height = "";
	});

	return {
		managed: () => true,
		availableHeight: () => height() || windowSize().height,
		requestSync: scheduleSync,
		keyboardOpen,
		offsetTop,
		safeAreaTop,
		safeAreaBottom,
	};
}
