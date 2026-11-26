import {
	type Accessor,
	cleanup,
	colorScheme,
	context,
	effect,
	signal,
	Storage,
	token,
	untracked,
} from "nsh";

import type { Theme } from "@shared/theme-settings-types";

export const WEB_COLOR_SCHEME_KEY = "pilo.web.color-scheme.v1";

export type DocumentColorScheme = "light dark" | "dark" | "only light";

export interface WebColorSchemeController {
	/** User preference for this browser (`"system"` follows device/browser theme). */
	preference: Accessor<Theme>;
	/** Persist and apply a new preference for this browser without mutating host settings. */
	setPreference: (next: Theme) => void;
	/** Resolves once fallback storage hydration completes. */
	ready: Promise<Theme>;
}

export const WebColorScheme = context<WebColorSchemeController | null>(null);

export function parseWebColorScheme(value: unknown): Theme | null {
	return value === "light" || value === "dark" || value === "system"
		? value
		: null;
}

export function resolveDocumentColorScheme(
	preference: Theme,
): DocumentColorScheme {
	if (preference === "dark") return "dark";
	if (preference === "light") return "only light";
	return "light dark";
}

type BrowserStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};

type MetaElementLike = {
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
	remove(): void;
};

type DocumentLike = {
	documentElement?: {
		style?: {
			colorScheme?: string;
			backgroundColor?: string;
		};
	} | null;
	body?: { style?: { backgroundColor?: string } } | null;
	head?: {
		appendChild(node: MetaElementLike): void;
		querySelectorAll(selector: string): Iterable<MetaElementLike>;
	} | null;
	createElement(tag: string): MetaElementLike;
};

type BrowserWindowLike = {
	parent?: BrowserWindowLike;
	localStorage?: BrowserStorage;
	document?: DocumentLike;
};

function browserGlobal(): BrowserWindowLike {
	return globalThis as unknown as BrowserWindowLike;
}

function resolveHostDocument(): DocumentLike | null {
	const current = browserGlobal();
	try {
		if (
			current.parent &&
			current.parent !== current &&
			current.parent.document
		) {
			return current.parent.document;
		}
	} catch {
		// Ignore cross-origin parent access errors.
	}
	return current.document ?? null;
}

function readLocalColorScheme(): Theme | null {
	try {
		return parseWebColorScheme(
			browserGlobal().localStorage?.getItem(WEB_COLOR_SCHEME_KEY),
		);
	} catch {
		return null;
	}
}

function writeLocalColorScheme(value: Theme): void {
	try {
		browserGlobal().localStorage?.setItem(WEB_COLOR_SCHEME_KEY, value);
	} catch {
		// Ignore storage write failures in private/sandboxed browsing contexts.
	}
}

function normalizeThemeColor(color: unknown, dark: boolean): string {
	if (typeof color === "string") {
		const trimmed = color.trim();
		if (/^#[0-9a-f]{8}$/i.test(trimmed)) return trimmed.slice(0, 7);
		if (trimmed) return trimmed;
	}
	return dark ? "#101010" : "#ffffff";
}

function syncMetaTag(
	doc: DocumentLike,
	name: string,
	content: string,
	clearMedia = false,
): void {
	const head = doc.head;
	if (!head) return;
	const existing = Array.from(head.querySelectorAll(`meta[name="${name}"]`));
	const target = existing[0] ?? doc.createElement("meta");
	if (existing.length === 0) {
		target.setAttribute("name", name);
		head.appendChild(target);
	} else {
		for (let i = 1; i < existing.length; i++) {
			existing[i]?.remove();
		}
	}
	if (clearMedia) target.removeAttribute("media");
	target.setAttribute("content", content);
}

/**
 * Synchronizes the hosting page's background, `color-scheme`, and theme
 * metadata with Pilo's active Web appearance. An explicit `color-scheme` on
 * `:root` tells Chromium/Android WebView that the page manages its own themes,
 * avoiding Force Dark inversion that leaves `<canvas>` icons dark-on-dark.
 */
function installHostDocumentColorSchemeSync(preference: Accessor<Theme>): void {
	let alive = true;
	cleanup(() => {
		alive = false;
	});

	effect(() => {
		const pref = preference();
		const resolved = colorScheme();
		const background = normalizeThemeColor(
			token("background"),
			resolved === "dark",
		);
		if (!alive) return;

		const doc = resolveHostDocument();
		if (!doc) return;

		const docScheme = resolveDocumentColorScheme(pref);
		try {
			if (doc.documentElement?.style) {
				doc.documentElement.style.colorScheme = docScheme;
				doc.documentElement.style.backgroundColor = background;
			}
			// The packaged body has its own background beneath the mobile viewport.
			if (doc.body?.style) doc.body.style.backgroundColor = background;
			syncMetaTag(doc, "color-scheme", docScheme);
			syncMetaTag(doc, "theme-color", background, true);
		} catch {
			// Ignore DOM mutation errors in restricted host realms.
		}
	});
}

/**
 * Creates per-browser Web color scheme state (defaulting to `"system"` so Web
 * follows the device/browser appearance automatically, while also allowing
 * manual `"light"` / `"dark"` overrides independent of the desktop Host).
 */
export function createWebColorScheme(): WebColorSchemeController {
	const initial = readLocalColorScheme();
	const preference = signal<Theme>(initial ?? "system");
	let userSelected = false;

	installHostDocumentColorSchemeSync(preference);

	const ready =
		initial !== null
			? Promise.resolve(initial)
			: Storage.getItem(WEB_COLOR_SCHEME_KEY)
					.then((stored) => {
						const parsed = parseWebColorScheme(stored);
						if (parsed && !userSelected) {
							writeLocalColorScheme(parsed);
							preference.set(parsed);
							return parsed;
						}
						return untracked(preference);
					})
					.catch(() => untracked(preference));

	const setPreference = (next: Theme) => {
		userSelected = true;
		preference.set(next);
		writeLocalColorScheme(next);
		void Storage.setItem(WEB_COLOR_SCHEME_KEY, next).catch(() => undefined);
	};

	return {
		preference,
		setPreference,
		ready,
	};
}
