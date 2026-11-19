import { readSavedCustomThemes } from "./theme-custom";
import type {
	ThemeSettings,
	ThemeSettingsUpdate,
} from "./theme-settings-types";
import { readCustomThemeTokens, renderCustomThemeCss } from "./theme-web";

export function supportsThemeTokens(settings: ThemeSettings): boolean {
	return Object.hasOwn(settings, "themeCustomTokens");
}

export function normalizeThemeSettings(next: ThemeSettings): ThemeSettings {
	return {
		...next,
		...(supportsThemeTokens(next)
			? { themeCustomTokens: readCustomThemeTokens(next.themeCustomTokens) }
			: {}),
		savedCustomThemes: readSavedCustomThemes(next.savedCustomThemes),
	};
}

export function compatibleThemeUpdate(
	update: ThemeSettingsUpdate,
	tokens: boolean,
): ThemeSettingsUpdate {
	if (tokens) return update;
	const { themeCustomTokens: _tokens, ...legacy } = update;
	if (legacy.saveCustomTheme) {
		const { name, css } = legacy.saveCustomTheme;
		return { ...legacy, saveCustomTheme: { name, css } };
	}
	return legacy;
}

export function customThemeCss(settings: ThemeSettings): string {
	if (settings.themeFamily !== "custom") return "";
	return supportsThemeTokens(settings)
		? renderCustomThemeCss(settings.themeCustomTokens)
		: settings.themeCustomCss;
}

export function legacyThemeInitial(settings: ThemeSettings) {
	const { themeCustomTokens: _tokens, ...legacy } = settings;
	return {
		...legacy,
		savedCustomThemes: settings.savedCustomThemes.map(({ name, css }) => ({
			name,
			css,
		})),
	};
}
