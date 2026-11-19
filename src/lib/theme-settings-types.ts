import type { SavedCustomTheme } from "./theme-custom";
import type { CustomThemeTokens } from "./theme-tokens";

export type Theme = "dark" | "light" | "system";
export type ThemeFamily = "lody" | "claude" | "custom";

export type ThemeSettings = {
	revision: number;
	theme: Theme;
	themeFamily: ThemeFamily;
	themeCustomCss: string;
	// Token contract: Host fields arrive in D2; missing fields normalize to {}.
	// themeCustomCss / saved css remain one release for rollback.
	// Until the Host sends this field, CSS remains the active contract.
	themeCustomTokens?: CustomThemeTokens;
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
	saveCustomTheme?: SavedCustomTheme;
	deleteCustomTheme?: string;
};
