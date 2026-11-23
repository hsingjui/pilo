import {
	type Accessor,
	computed,
	effect,
	platform,
	setColorScheme,
	setTheme,
	signal,
	Storage,
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
import claude from "../../theme/claude-theme.json";
import type { AppState } from "../state/app-state";
import lody from "../../theme/theme.json";
import { setStyleTheme } from "../ui/theme-style";
import { appLocale, setAppLocale } from "./i18n";

const catalog = createThemeTokenCatalog(lody.cssVars);
const defaultPageFont =
	platform.os === "windows"
		? "Noto Sans SC"
		: platform.os === "web"
			? "inter"
			: "system-sans";
const defaultMonoFont =
	platform.os === "web" ? "jetbrains-mono" : "system-mono";

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
			getPageFontFamilyStack(defaultPageFont),
			getMonospaceFontFamilyStack(defaultMonoFont),
			undefined,
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
	if (
		themeFamily !== "lody" &&
		themeFamily !== "claude" &&
		themeFamily !== "custom"
	) {
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
	const pageSans = computed(() => {
		const saved = state().preferences?.values.pageFontFamily;
		if (platform.os === "web") {
			return getPageFontFamilyStack(
				!saved || saved === "system-sans" ? "inter" : saved,
			);
		}
		return getPageFontFamilyStack(saved ?? defaultPageFont);
	});
	const codeMono = computed(() => {
		const saved = state().preferences?.values.codeFontFamily;
		if (platform.os === "web") {
			return getMonospaceFontFamilyStack(
				!saved || saved === "system-mono" ? "jetbrains-mono" : saved,
			);
		}
		return getMonospaceFontFamilyStack(saved ?? defaultMonoFont);
	});
	const codeFontSize = computed(() => state().preferences?.values.codeFontSize);
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
	settings: StartupTheme | null,
	pageSans: string,
	codeMono: string,
	codeSize: number | undefined,
) {
	setColorScheme(settings?.theme ?? "system");
	const isClaude = settings?.themeFamily === "claude";
	setStyleTheme(isClaude ? claude.styleVars : null);
	const vars = isClaude ? claude.cssVars : lodyTheme(settings, pageSans);
	const display = vars.theme?.["font-display"];
	displayFontFamily.set(typeof display === "string" ? display : pageSans);
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
