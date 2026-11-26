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
	resolveMobileSafeAreaTop,
	VIEWPORT_EPSILON_PX,
	type MobileViewportLayout,
} from "@shared/mobile-viewport";

export interface MobileViewportState {
	/** True when browser visualViewport sync owns `#app` geometry. */
	managed: Accessor<boolean>;
	/** Height available to content, without subtracting the keyboard twice. */
	availableHeight: Accessor<number>;
	/** True when the visual viewport shrank enough to indicate a software keyboard. */
	keyboardOpen: Accessor<boolean>;
	/** Current clamped visualViewport.offsetTop in CSS pixels. */
	offsetTop: Accessor<number>;
	/**
	 * Top safe-area inset that stays stable when iOS Safari scrolls
	 * `visualViewport.offsetTop` down while `#app` follows the visual viewport.
	 */
	safeAreaTop: Accessor<number>;
}

const defaultMobileViewport: MobileViewportState = {
	managed: () => false,
	availableHeight: () =>
		Math.max(0, windowSize().height - keyboardFrame().height),
	keyboardOpen: () => false,
	offsetTop: () => 0,
	safeAreaTop: () => safeArea().top,
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

type HostAppElement = {
	style: {
		top: string;
		bottom: string;
		height: string;
	};
};

type HostWindow = {
	parent?: HostWindow;
	innerHeight?: number;
	scrollY?: number;
	visualViewport?: HostVisualViewport | null;
	document?: {
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
	let lastBaselineWidth = windowSize().width;

	effect(() => {
		const width = windowSize().width;
		const top = safeArea().top;
		const currentOffsetTop = offsetTop();
		if (width !== lastBaselineWidth) {
			lastBaselineWidth = width;
			untracked(() => baselineSafeAreaTop.set(top));
			return;
		}
		if (currentOffsetTop <= VIEWPORT_EPSILON_PX) {
			untracked(() => baselineSafeAreaTop.set(top));
		}
	});

	const safeAreaTop = computed(() =>
		resolveMobileSafeAreaTop({
			safeAreaTop: safeArea().top,
			baselineTop: baselineSafeAreaTop(),
			offsetTop: offsetTop(),
		}),
	);

	let appliedKey = "default";
	let pendingFrame: number | null = null;

	const applyLayout = (layout: MobileViewportLayout) => {
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

	const sync = () => {
		const layout = computeMobileViewportLayout({
			innerHeight: host.innerHeight ?? 0,
			viewportHeight: viewport.height,
			offsetTop: viewport.offsetTop,
			scale: viewport.scale,
			scrollY: host.scrollY ?? 0,
		});
		applyLayout(layout);
	};

	const scheduleSync = () => {
		if (pendingFrame !== null) return;
		if (typeof host.requestAnimationFrame === "function") {
			pendingFrame = host.requestAnimationFrame(() => {
				pendingFrame = null;
				sync();
			});
			return;
		}
		sync();
	};

	sync();
	// Update #app before nsh measures its insets. Offset-only changes don't
	// trigger the host's ResizeObserver, so it must read the new position here.
	viewport.addEventListener("resize", sync, true);
	viewport.addEventListener("scroll", sync, true);
	host.addEventListener?.("resize", sync, true);
	host.addEventListener?.("orientationchange", scheduleSync);
	host.document?.addEventListener("focusout", scheduleSync);

	cleanup(() => {
		if (pendingFrame !== null) {
			host.cancelAnimationFrame?.(pendingFrame);
			pendingFrame = null;
		}
		viewport.removeEventListener("resize", sync, true);
		viewport.removeEventListener("scroll", sync, true);
		host.removeEventListener?.("resize", sync, true);
		host.removeEventListener?.("orientationchange", scheduleSync);
		host.document?.removeEventListener("focusout", scheduleSync);
		app.style.top = "";
		app.style.bottom = "";
		app.style.height = "";
	});

	return {
		managed: () => true,
		availableHeight: () => height() || windowSize().height,
		keyboardOpen,
		offsetTop,
		safeAreaTop,
	};
}
