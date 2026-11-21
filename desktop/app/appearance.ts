import {
	type Accessor,
	computed,
	effect,
	platform,
	setColorScheme,
	setTheme,
	untracked,
} from "nsh";

import {
	getMonospaceFontFamilyStack,
	getPageFontFamilyStack,
} from "@shared/font-stacks";
import type { ThemeSettings } from "@shared/theme-settings-types";
import {
	createThemeTokenCatalog,
	resolveCustomTheme,
	type ThemeCssVars,
	validateCustomThemeTokens,
} from "@shared/theme-tokens";
import claude from "../claude-theme.json";
import type { AppState } from "../state/app-state";
import lody from "../theme.json";
import { setStyleTheme } from "../ui/theme-style";
import { appLocale, setAppLocale } from "./i18n";

const catalog = createThemeTokenCatalog(lody.cssVars);
const defaultPageFont =
	platform.os === "windows" ? "Noto Sans SC" : "system-sans";

/** Follow saved appearance, using platform fonts until preferences load. */
export function followSavedAppearance(state: Accessor<AppState>) {
	const locale = computed(() => state().preferences?.values.locale);
	const pageSans = computed(() =>
		getPageFontFamilyStack(
			state().preferences?.values.pageFontFamily ?? defaultPageFont,
		),
	);
	const codeMono = computed(() =>
		getMonospaceFontFamilyStack(
			state().preferences?.values.codeFontFamily ?? "system-mono",
		),
	);
	const codeFontSize = computed(() => state().preferences?.values.codeFontSize);
	const theme = computed(() => state().themeSettings);
	effect(() => {
		const savedLocale = locale();
		if (savedLocale && savedLocale !== untracked(appLocale))
			void setAppLocale(savedLocale);
	});
	const themeInputs = computed(
		() => [theme(), pageSans(), codeMono(), codeFontSize()] as const,
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

function showTheme(
	settings: ThemeSettings | null,
	pageSans: string,
	codeMono: string,
	codeSize: number | undefined,
) {
	setColorScheme(settings?.theme ?? "system");
	const isClaude = settings?.themeFamily === "claude";
	setStyleTheme(isClaude ? claude.styleVars : null);
	const vars = isClaude ? claude.cssVars : lodyTheme(settings, pageSans);
	setTheme({
		cssVars: {
			...vars,
			theme: {
				...vars.theme,
				"font-sans": pageSans,
				"font-mono": codeMono,
				...(codeSize === undefined
					? {}
					: { "pilo-code-font-size": `${codeSize}px` }),
			},
		},
	});
}

/** Lody uses the page font for display unless a custom theme overrides it. */
function lodyTheme(
	settings: ThemeSettings | null,
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
