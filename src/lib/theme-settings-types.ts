import type { SavedCustomTheme } from "./theme-custom";

export type Theme = "dark" | "light" | "system";
export type ThemeFamily = "lody" | "claude" | "custom";

export type ThemeSettings = {
	revision: number;
	theme: Theme;
	themeFamily: ThemeFamily;
	themeCustomCss: string;
	themeCustomName: string;
	savedCustomThemes: SavedCustomTheme[];
};

export type ThemeSettingsUpdate = Partial<
	Pick<
		ThemeSettings,
		"theme" | "themeFamily" | "themeCustomCss" | "themeCustomName"
	>
> & {
	saveCustomTheme?: SavedCustomTheme;
	deleteCustomTheme?: string;
};
