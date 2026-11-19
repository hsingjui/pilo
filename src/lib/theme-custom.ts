import type { CustomThemeTokens } from "./theme-tokens";
import { readCustomThemeTokens } from "./theme-web";

/** 注入用 <style> 元素 id，boot 脚本与 ThemeProvider 共用同一元素。 */
export const CUSTOM_THEME_STYLE_ID = "pilo-custom-theme-css";

export type SavedCustomTheme = {
	name: string;
	css: string;
	// Saved themes use tokens; css is retained one release for rollback (Host D2).
	tokens: CustomThemeTokens;
};

export function isThemeCustomCss(value: unknown): value is string {
	return typeof value === "string";
}

export function readSavedCustomThemes(value: unknown): SavedCustomTheme[] {
	if (!Array.isArray(value)) return [];
	const themes = new Map<string, SavedCustomTheme>();
	for (const entry of value) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!("name" in entry) ||
			typeof entry.name !== "string" ||
			("css" in entry && typeof entry.css !== "string")
		)
			continue;
		const name = entry.name.trim();
		if (name)
			themes.set(name, {
				name,
				css: "css" in entry ? (entry.css as string) : "",
				tokens: readCustomThemeTokens(
					"tokens" in entry ? entry.tokens : undefined,
				),
			});
	}
	return [...themes.values()];
}
