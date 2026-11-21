import base from "../desktop/theme.json" with { type: "json" };
import mapping from "./theme-web-map.json" with { type: "json" };
import {
	createThemeTokenCatalog,
	parseThemeColor,
	validateCustomThemeTokens,
	THEME_TOKEN_SCOPES,
	type CustomThemeTokens,
} from "./theme-tokens";

export const CUSTOM_THEME_CATALOG = createThemeTokenCatalog(base.cssVars);
export const CUSTOM_THEME_BASE = base.cssVars;
const tokenMapping = new Map(Object.entries(mapping));

export function validateWebThemeTokens(input: unknown) {
	return validateCustomThemeTokens(input, CUSTOM_THEME_CATALOG);
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
				const entry = tokenMapping.get(token);
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
	if (typeof input !== "object" || input === null || Array.isArray(input))
		return {};
	let tokens: CustomThemeTokens = {};
	for (const scope of THEME_TOKEN_SCOPES) {
		const entries: unknown = Reflect.get(input, scope);
		if (
			typeof entries !== "object" ||
			entries === null ||
			Array.isArray(entries)
		)
			continue;
		for (const [token, value] of Object.entries(entries)) {
			const result = validateWebThemeTokens({
				...tokens,
				[scope]: { ...tokens[scope], [token]: value },
			});
			if (result.ok) tokens = result.tokens;
		}
	}
	return tokens;
}
