import {
	type Accessor,
	computed,
	effect,
	setColorScheme,
	setTheme,
	untracked,
} from "nsh";

import {
	getMonospaceFontFamilyStack,
	getPageFontFamilyStack,
} from "@/lib/font-stacks";
import type { HostPreferenceValues } from "@/lib/host-preferences-types";
import type { ThemeSettings } from "@/lib/theme-settings-types";
import {
	createThemeTokenCatalog,
	resolveCustomTheme,
	type ThemeCssVars,
	validateCustomThemeTokens,
} from "@/lib/theme-tokens";
import claude from "../claude-theme.json";
import type { AppState } from "../state/app-state";
import lody from "../theme.json";
import { setStyleTheme } from "../ui/theme-style";
import { appLocale, setAppLocale } from "./i18n";

const catalog = createThemeTokenCatalog(lody.cssVars);

/**
 * Shows the app in the language, appearance, theme and fonts the user saved,
 * once the app state holds them and whenever they change. Call while
 * rendering.
 *
 * The saved UI font size is not shown: nsh has no text size an app can set.
 */
export function followSavedAppearance(state: Accessor<AppState>) {
	const saved = <K extends keyof HostPreferenceValues>(name: K) =>
		computed(() => state().preferences?.values[name]);
	const locale = saved("locale");
	const pageFont = saved("pageFontFamily");
	const codeFont = saved("codeFontFamily");
	const codeFontSize = saved("codeFontSize");
	const theme = computed(() => state().themeSettings);
	effect(() => {
		const savedLocale = locale();
		if (savedLocale && savedLocale !== untracked(appLocale))
			void setAppLocale(savedLocale);
	});
	effect(() => {
		const settings = theme();
		if (!settings) return;
		const page = pageFont();
		const code = codeFont();
		const size = codeFontSize();
		showTheme(
			settings,
			page !== undefined && code !== undefined && size !== undefined
				? fontTokens(page, code, size)
				: undefined,
		);
	});
}

type FontTokens = ReturnType<typeof fontTokens>;

/** The saved fonts as the theme tokens that show them. */
function fontTokens(page: string, code: string, codeSize: number) {
	return {
		"font-sans": getPageFontFamilyStack(page),
		"font-mono": getMonospaceFontFamilyStack(code),
		"pilo-code-font-size": `${codeSize}px`,
	};
}

/** The saved fonts replace the theme's own, a custom theme's included. */
function showTheme(settings: ThemeSettings, fonts: FontTokens | undefined) {
	setColorScheme(settings.theme);
	const isClaude = settings.themeFamily === "claude";
	setStyleTheme(isClaude ? claude.styleVars : null);
	const vars = isClaude ? claude.cssVars : lodyTheme(settings, fonts);
	setTheme({ cssVars: fonts ? withTokens(vars, fonts) : vars });
}

/**
 * Lody, with the saved custom tokens over it when the theme is a valid custom
 * one. Lody's display font is the page font; a custom theme may name another.
 */
function lodyTheme(
	settings: ThemeSettings,
	fonts: FontTokens | undefined,
): ThemeCssVars {
	const base = fonts
		? withTokens(lody.cssVars, { "font-display": fonts["font-sans"] })
		: lody.cssVars;
	if (settings.themeFamily !== "custom") return base;
	const custom = validateCustomThemeTokens(
		settings.themeCustomTokens ?? {},
		catalog,
	);
	return custom.ok ? resolveCustomTheme(base, custom.tokens) : base;
}

/** `vars` with `tokens` set for both appearances. */
function withTokens(
	vars: ThemeCssVars,
	tokens: Record<string, string>,
): ThemeCssVars {
	return { ...vars, theme: { ...vars.theme, ...tokens } };
}
