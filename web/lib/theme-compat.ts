import { readSavedCustomThemes } from "@shared/theme-custom";
import type {
	ThemeSettings,
	ThemeSettingsUpdate,
} from "@shared/theme-settings-types";
import { readCustomThemeTokens, renderCustomThemeCss } from "@shared/theme-web";

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
	update: ThemeSettingsUpdate & Pick<ThemeSettings, "themeCustomConversion">,
	tokens: boolean,
): ThemeSettingsUpdate {
	const { themeCustomConversion: _conversion, ...writable } = update;
	if (tokens) return writable;
	const { themeCustomTokens: _tokens, ...legacy } = writable;
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
	const {
		themeCustomTokens: _tokens,
		themeCustomConversion: _conversion,
		...legacy
	} = settings;
	return {
		...legacy,
		savedCustomThemes: settings.savedCustomThemes.map(({ name, css }) => ({
			name,
			css,
		})),
	};
}
