import {
	type Accessor,
	computed,
	effect,
	setColorScheme,
	setTheme,
	signal,
	Storage,
	untracked,
} from "nsh";

import {
	DEFAULT_CODE_FONT_FAMILY,
	DEFAULT_PAGE_FONT_FAMILY,
	DEFAULT_UI_FONT_SIZE,
	getMonospaceFontFamilyStack,
	getPageFontFamilyStack,
} from "@shared/font-settings";
import {
	type BuiltinThemeFamily,
	isBuiltinThemeFamily,
	isThemeFamily,
	type ThemeSettings,
} from "@shared/theme-settings-types";
import {
	createThemeTokenCatalog,
	resolveCustomTheme,
	type ThemeCssVars,
	validateCustomThemeTokens,
} from "@shared/theme-tokens";
import claude from "../../theme/claude-theme.json";
import ember from "../../theme/ember-theme.json";
import grove from "../../theme/grove-theme.json";
import iris from "../../theme/iris-theme.json";
import ocean from "../../theme/ocean-theme.json";
import type { AppState } from "../state/app-state";
import lody from "../../theme/theme.json";
import { setStyleTheme, type StyleVariables } from "../ui/theme-style";
import { appLocale, setAppLocale } from "./i18n";

// nsh omits system-ui fonts from the generated tokens, but themes can set them at runtime.
declare module "nsh" {
	interface Tokens {
		"font-sans"?: string;
		"font-display"?: string;
	}
}

export type GeneratedTheme = {
	cssVars: ThemeCssVars;
	styleVars: StyleVariables;
};

export const BUILTIN_THEMES: Record<BuiltinThemeFamily, GeneratedTheme> = {
	lody,
	claude,
	grove,
	ocean,
	ember,
	iris,
};

function readThemeColor(
	cssVars: ThemeCssVars,
	scheme: "light" | "dark",
	tokenName: string,
): string {
	const value =
		(scheme === "dark" ? cssVars.dark?.[tokenName] : undefined) ??
		cssVars.light?.[tokenName] ??
		cssVars.theme?.[tokenName];
	return typeof value === "string" ? value : "";
}

/** Preview colors for the appearance picker, derived from the theme JSON. */
export function themePreviewColors(
	family: BuiltinThemeFamily,
	scheme: "light" | "dark",
): { canvas: string; accent: string } {
	const { cssVars } = BUILTIN_THEMES[family];
	return {
		canvas: readThemeColor(cssVars, scheme, "background"),
		accent: readThemeColor(cssVars, scheme, "primary"),
	};
}

const catalog = createThemeTokenCatalog(lody.cssVars);
export const MIN_UI_FONT_SIZE = 14;
export const MAX_UI_FONT_SIZE = 20;
const uiTextTokens = Object.entries(lody.cssVars.theme)
	.filter(([name]) => name.startsWith("pilo-ui-text-"))
	.map(([name, size]) => [name, Number.parseFloat(size)] as const);

/** Scale the app's named UI text sizes without changing nsh's OS fontScale. */
function uiTextSizes(size: number) {
	const scale =
		Math.min(MAX_UI_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, size)) /
		DEFAULT_UI_FONT_SIZE;
	return Object.fromEntries(
		uiTextTokens.map(([name, base]) => [
			name,
			`${(base * scale).toFixed(3)}px`,
		]),
	);
}

// nsh 0.6.1 keeps only the first family when parsing font tokens.
export const displayFontFamily = signal(lody.cssVars.theme["font-display"]);

/** What the first frame needs of the theme, before the Host answers. */
export type StartupTheme = Pick<
	ThemeSettings,
	"theme" | "themeFamily" | "themeCustomTokens"
>;
const STARTUP_THEME_KEY = "pilo.startupTheme";

/**
 * Shows the theme the last run saved, so a launch or reload does not flash
 * the default theme before the Host's settings arrive.
 */
export async function showStartupTheme(): Promise<StartupTheme | null> {
	const saved = parseStartupTheme(
		await Storage.getItem(STARTUP_THEME_KEY).catch(() => null),
	);
	if (saved) {
		showTheme(
			saved,
			getPageFontFamilyStack(DEFAULT_PAGE_FONT_FAMILY),
			getMonospaceFontFamilyStack(DEFAULT_CODE_FONT_FAMILY),
			undefined,
			DEFAULT_UI_FONT_SIZE,
		);
	}
	return saved;
}

function parseStartupTheme(stored: string | null): StartupTheme | null {
	if (!stored) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stored);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { theme, themeFamily, themeCustomTokens } = parsed as Record<
		string,
		unknown
	>;
	if (theme !== "dark" && theme !== "light" && theme !== "system") {
		return null;
	}
	if (!isThemeFamily(themeFamily)) {
		return null;
	}
	// showTheme validates custom tokens before using them.
	return {
		theme,
		themeFamily,
		themeCustomTokens:
			typeof themeCustomTokens === "object" && themeCustomTokens !== null
				? (themeCustomTokens as StartupTheme["themeCustomTokens"])
				: undefined,
	};
}

/** Follow saved appearance, using platform fonts until preferences load. */
export function followSavedAppearance(state: Accessor<AppState>) {
	const locale = computed(() => state().preferences?.values.locale);
	const pageSans = computed(() =>
		getPageFontFamilyStack(
			state().preferences?.values.pageFontFamily ?? DEFAULT_PAGE_FONT_FAMILY,
		),
	);
	const codeMono = computed(() =>
		getMonospaceFontFamilyStack(
			state().preferences?.values.codeFontFamily ?? DEFAULT_CODE_FONT_FAMILY,
		),
	);
	const codeFontSize = computed(() => state().preferences?.values.codeFontSize);
	const uiFontSize = computed(
		() => state().preferences?.values.uiFontSize ?? DEFAULT_UI_FONT_SIZE,
	);
	const theme = computed(() => state().themeSettings);
	const startupTheme = computed(() => {
		const settings = theme();
		if (!settings) return null;
		const { theme: scheme, themeFamily, themeCustomTokens } = settings;
		return JSON.stringify({ theme: scheme, themeFamily, themeCustomTokens });
	});
	effect(() => {
		const saved = startupTheme();
		if (!saved) return;
		void Storage.setItem(STARTUP_THEME_KEY, saved).catch((error: unknown) => {
			console.warn("Failed to save the startup theme", error);
		});
	});
	effect(() => {
		const savedLocale = locale();
		if (savedLocale && savedLocale !== untracked(appLocale))
			setAppLocale(savedLocale);
	});
	const themeInputs = computed(
		() =>
			[theme(), pageSans(), codeMono(), codeFontSize(), uiFontSize()] as const,
	);
	// Effects run after rendering; set the theme before building the first layout.
	let applied = untracked(themeInputs);
	showTheme(...applied);
	effect(() => {
		const next = themeInputs();
		if (next === applied) return;
		showTheme(...next);
		applied = next;
	});
}

let lastThemeKey: string | null = null;

function showTheme(
	settings: StartupTheme | null,
	pageSans: string,
	codeMono: string,
	codeSize: number | undefined,
	uiSize: number,
) {
	const key = JSON.stringify([
		settings?.theme ?? "system",
		settings?.themeFamily ?? "lody",
		settings?.themeFamily === "custom"
			? (settings.themeCustomTokens ?? null)
			: null,
		pageSans,
		codeMono,
		codeSize ?? null,
		uiSize,
	]);
	if (key === lastThemeKey) return;
	lastThemeKey = key;
	setColorScheme(settings?.theme ?? "system");
	const family = settings?.themeFamily ?? "lody";
	const builtIn = isBuiltinThemeFamily(family) ? BUILTIN_THEMES[family] : null;
	setStyleTheme(builtIn && family !== "lody" ? builtIn.styleVars : null);
	const vars = builtIn
		? builtinTheme(builtIn, pageSans)
		: lodyTheme(settings, pageSans);
	const display = vars.theme?.["font-display"];
	displayFontFamily.set(typeof display === "string" ? display : pageSans);
	setTheme({
		cssVars: {
			...vars,
			theme: {
				...vars.theme,
				...uiTextSizes(uiSize),
				"font-sans": pageSans,
				"font-mono": codeMono,
				...(codeSize === undefined
					? {}
					: { "pilo-code-font-size": `${codeSize}px` }),
			},
		},
	});
}

function builtinTheme(theme: GeneratedTheme, pageSans: string): ThemeCssVars {
	const hasCustomDisplay =
		typeof theme.cssVars.theme?.["font-display"] === "string" &&
		theme.cssVars.theme["font-display"] !== theme.cssVars.theme["font-sans"];
	if (hasCustomDisplay) return theme.cssVars;
	return {
		...theme.cssVars,
		theme: { ...theme.cssVars.theme, "font-display": pageSans },
	};
}

/** Lody uses the page font for display unless a custom theme overrides it. */
function lodyTheme(
	settings: StartupTheme | null,
	pageSans: string,
): ThemeCssVars {
	const base = {
		...lody.cssVars,
		theme: { ...lody.cssVars.theme, "font-display": pageSans },
	};
	if (settings?.themeFamily !== "custom") return base;
	const custom = validateCustomThemeTokens(
		settings.themeCustomTokens ?? {},
		catalog,
	);
	return custom.ok ? resolveCustomTheme(base, custom.tokens) : base;
}
