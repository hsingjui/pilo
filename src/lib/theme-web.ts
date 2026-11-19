import base from "../../desktop/theme.json" with { type: "json" };
import mapping from "./theme-web-map.json" with { type: "json" };
import {
	createThemeTokenCatalog,
	parseThemeColor,
	validateCustomThemeTokens,
	type CustomThemeTokens,
	type ThemeTokenIssue,
	type ThemeTokenScope,
} from "./theme-tokens";

export const CUSTOM_THEME_CATALOG = createThemeTokenCatalog(base.cssVars);
export const CUSTOM_THEME_BASE = base.cssVars;

export type WebThemeIssue =
	| ThemeTokenIssue
	| {
			code: "alpha-not-supported";
			scope: ThemeTokenScope;
			token: string;
	  };

export function validateWebThemeAlpha(
	tokens: CustomThemeTokens,
): WebThemeIssue[] {
	const issues: WebThemeIssue[] = [];
	for (const scope of ["theme", "light", "dark"] as const) {
		for (const [token, value] of Object.entries(tokens[scope] ?? {})) {
			const entry = Object.entries(mapping).find(
				([name]) => name === token,
			)?.[1];
			const color = parseThemeColor(value);
			if (entry?.format === "hsl-channels" && color && !color.endsWith("ff"))
				issues.push({ code: "alpha-not-supported", scope, token });
		}
	}
	return issues;
}

export function validateWebThemeTokens(
	input: unknown,
):
	| { ok: true; tokens: CustomThemeTokens }
	| { ok: false; issues: WebThemeIssue[] } {
	const result = validateCustomThemeTokens(input, CUSTOM_THEME_CATALOG);
	if (!result.ok) return result;
	const issues = validateWebThemeAlpha(result.tokens);
	return issues.length ? { ok: false, issues } : result;
}

const round = (n: number) => Number(n.toFixed(4));

function hslChannels(value: string): string {
	const hex = parseThemeColor(value) ?? "#000000ff";
	const [r, g, b] = [1, 3, 5].map(
		(start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255,
	);
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const delta = max - min;
	const lightness = (max + min) / 2;
	let hue = 0;
	if (delta) {
		if (max === r) hue = ((g - b) / delta) % 6;
		else if (max === g) hue = (b - r) / delta + 2;
		else hue = (r - g) / delta + 4;
	}
	const saturation = delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0;
	return `${round((hue * 60 + 360) % 360)} ${round(saturation * 100)}% ${round(lightness * 100)}%`;
}

export function renderCustomThemeCss(input: unknown): string {
	const result = validateWebThemeTokens(input);
	if (!result.ok) return "";
	const declarations = (tokens: Record<string, string>) =>
		Object.entries(tokens)
			.map(([token, value]) => {
				const entry = Object.entries(mapping).find(
					([name]) => name === token,
				)?.[1];
				return `--${entry?.cssVar ?? token}:${entry?.format === "hsl-channels" ? hslChannels(value) : value};`;
			})
			.join("");
	const common = declarations({
		...result.tokens.theme,
		...result.tokens.light,
	});
	const dark = declarations(result.tokens.dark ?? {});
	return `${common ? `:root[data-theme-family="custom"]{${common}}` : ""}${dark ? `.dark:root[data-theme-family="custom"]{${dark}}` : ""}`;
}

export function readCustomThemeTokens(input: unknown): CustomThemeTokens {
	const result = validateWebThemeTokens(input ?? {});
	return result.ok ? result.tokens : {};
}
