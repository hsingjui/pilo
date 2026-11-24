import type { CustomThemeTokens } from "./theme-tokens";

export type SavedCustomTheme = {
	name: string;
	css: string;
	tokens?: CustomThemeTokens;
};

export type Theme = "dark" | "light" | "system";
export type ThemeFamily = "lody" | "claude" | "custom";

export type ThemeConversionIssue = {
	kind: "rule" | "declaration";
	selector?: string;
	text: string;
	reason:
		| "unsupported-at-rule"
		| "unsupported-selector"
		| "malformed"
		| "not-custom-property"
		| "unknown-token"
		| "unsupported-value"
		| "invalid-value"
		| "appearance-not-allowed";
};

export type ThemeCustomConversion = {
	current: ThemeConversionIssue[];
	savedThemes: { name: string; issues: ThemeConversionIssue[] }[];
};

export type ThemeSettings = {
	revision: number;
	theme: Theme;
	themeFamily: ThemeFamily;
	themeCustomCss: string;
	// Token contract: Host fields arrive in D2; missing fields normalize to {}.
	// themeCustomCss / saved css remain one release for rollback.
	// Until the Host sends this field, CSS remains the active contract.
	themeCustomTokens?: CustomThemeTokens;
	readonly themeCustomConversion?: ThemeCustomConversion;
	themeCustomName: string;
	savedCustomThemes: SavedCustomTheme[];
};

export type ThemeSettingsUpdate = Partial<
	Pick<
		ThemeSettings,
		| "theme"
		| "themeFamily"
		| "themeCustomCss"
		| "themeCustomTokens"
		| "themeCustomName"
	>
> & {
	saveCustomTheme?: Omit<SavedCustomTheme, "css"> & { css?: string };
	deleteCustomTheme?: string;
};
