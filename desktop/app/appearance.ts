import {
	type Accessor,
	computed,
	effect,
	setColorScheme,
	setTheme,
	untracked,
} from "nsh";

import type { ThemeSettings } from "@/lib/theme-settings-types";
import {
	createThemeTokenCatalog,
	resolveCustomTheme,
	validateCustomThemeTokens,
} from "@/lib/theme-tokens";
import claude from "../claude-theme.json";
import type { AppState } from "../state/app-state";
import lody from "../theme.json";
import { setStyleTheme } from "../ui/theme-style";
import { appLocale, setAppLocale } from "./i18n";

const catalog = createThemeTokenCatalog(lody.cssVars);

/**
 * Shows the app in the language, appearance and theme the user saved, once
 * the app state holds them and whenever they change. Call while rendering.
 */
export function followSavedAppearance(state: Accessor<AppState>) {
	const locale = computed(() => state().preferences?.values.locale);
	const theme = computed(() => state().themeSettings);
	effect(() => {
		const saved = locale();
		if (saved && saved !== untracked(appLocale)) void setAppLocale(saved);
	});
	effect(() => {
		const saved = theme();
		if (saved) showTheme(saved);
	});
}

function showTheme(settings: ThemeSettings) {
	setColorScheme(settings.theme);
	if (settings.themeFamily === "claude") {
		setTheme({ cssVars: claude.cssVars });
		setStyleTheme(claude.styleVars);
		return;
	}
	setStyleTheme(null);
	setTheme(settings.themeFamily === "custom" ? customTheme(settings) : null);
}

/** Lody with the saved custom tokens over it; Lody alone when they are invalid. */
function customTheme(settings: ThemeSettings) {
	const custom = validateCustomThemeTokens(
		settings.themeCustomTokens ?? {},
		catalog,
	);
	return custom.ok
		? { cssVars: resolveCustomTheme(lody.cssVars, custom.tokens) }
		: null;
}
