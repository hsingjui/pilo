import {
	type Accessor,
	computed,
	context,
	signal,
	Storage,
	untracked,
} from "nsh";

import {
	DEFAULT_WEB_FONT_SCALE,
	parseWebFontScale,
	resolveWebFontMetrics,
	type WebFontMetrics,
	type WebFontScalePreset,
} from "@shared/web-font-scale";

export const WEB_FONT_SCALE_KEY = "pilo.web.font-scale.v1";

export interface WebFontScaleController {
	/** User text size preference for this browser (`"default"` uses 16px mobile scale). */
	preference: Accessor<WebFontScalePreset>;
	/** Resolved UI scale, reading font size, and code font size for the active preset. */
	metrics: Accessor<WebFontMetrics>;
	/** Persist and apply a new preset for this browser without mutating host settings. */
	setPreference: (next: WebFontScalePreset) => void;
	/** Resolves once fallback storage hydration completes. */
	ready: Promise<WebFontScalePreset>;
}

export const WebFontScale = context<WebFontScaleController | null>(null);

type BrowserStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};

type BrowserWindowLike = {
	localStorage?: BrowserStorage;
};

function browserGlobal(): BrowserWindowLike {
	return globalThis as unknown as BrowserWindowLike;
}

function readLocalFontScale(): WebFontScalePreset | null {
	try {
		return parseWebFontScale(
			browserGlobal().localStorage?.getItem(WEB_FONT_SCALE_KEY),
		);
	} catch {
		return null;
	}
}

function writeLocalFontScale(value: WebFontScalePreset): void {
	try {
		browserGlobal().localStorage?.setItem(WEB_FONT_SCALE_KEY, value);
	} catch {
		// Ignore storage write failures in private/sandboxed browsing contexts.
	}
}

/**
 * Creates per-browser Web text size state (defaulting to `"default"` with a
 * 16px mobile scale, while allowing `"small"` / `"default"` / `"large"`
 * overrides independent of the desktop Host's font sizes).
 */
export function createWebFontScale(): WebFontScaleController {
	const initial = readLocalFontScale();
	const preference = signal<WebFontScalePreset>(
		initial ?? DEFAULT_WEB_FONT_SCALE,
	);
	const metrics = computed(() => resolveWebFontMetrics(preference()));
	let userSelected = false;

	const ready =
		initial !== null
			? Promise.resolve(initial)
			: Storage.getItem(WEB_FONT_SCALE_KEY)
					.then((stored) => {
						const parsed = parseWebFontScale(stored);
						if (parsed && !userSelected) {
							writeLocalFontScale(parsed);
							preference.set(parsed);
							return parsed;
						}
						return untracked(preference);
					})
					.catch(() => untracked(preference));

	const setPreference = (next: WebFontScalePreset) => {
		userSelected = true;
		preference.set(next);
		writeLocalFontScale(next);
		void Storage.setItem(WEB_FONT_SCALE_KEY, next).catch(() => undefined);
	};

	return {
		preference,
		metrics,
		setPreference,
		ready,
	};
}
