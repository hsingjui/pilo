/**
 * 自定义主题 token 表：桌面端（nsh `setTheme`）与 WebUI 共用的格式与校验。
 *
 * 格式与 nsh `Theme.cssVars` 同构：`theme` 两种外观共用，`light` 用于亮色并在
 * `dark` 未覆盖时也用于暗色，`dark` 只用于暗色。可用 token 及其取值类型由基础
 * 主题（`desktop/theme.json` 的 `cssVars`）决定，调用方把它传给
 * `createThemeTokenCatalog`。
 */

export const THEME_TOKEN_SCOPES = ["theme", "light", "dark"] as const;
export type ThemeTokenScope = (typeof THEME_TOKEN_SCOPES)[number];

/**
 * `opaque-color`：WebUI 把这些颜色存成 HSL 通道（`H S% L%`），按
 * `hsl(var(--x) / a)` 使用，放不下自身透明度，所以只接受不透明颜色。
 * `color`：WebUI 里本身就是完整颜色的 `--pilo-*` token，可以带透明度。
 */
export type ThemeTokenKind =
	| "color"
	| "opaque-color"
	| "length"
	| "number"
	| "font";

export function isColorKind(kind: ThemeTokenKind): boolean {
	return kind === "color" || kind === "opaque-color";
}

/** 保存的自定义主题内容：每个值都是校验过的字符串。 */
export type CustomThemeTokens = Partial<
	Record<ThemeTokenScope, Record<string, string>>
>;

/** nsh `Theme.cssVars`，即生成的 `desktop/theme.json` 的 `cssVars`。 */
export type ThemeCssVars = Partial<
	Record<ThemeTokenScope, Record<string, string | number>>
>;

export type SavedTokenTheme = {
	name: string;
	tokens: CustomThemeTokens;
};

export type ThemeTokenCatalog = ReadonlyMap<string, ThemeTokenKind>;

export type ThemeTokenIssue =
	| { code: "not-an-object"; scope?: ThemeTokenScope }
	| { code: "unknown-scope"; scope: string }
	| { code: "unknown-token"; scope: ThemeTokenScope; token: string }
	| {
			code: "invalid-value";
			scope: ThemeTokenScope;
			token: string;
			expected: ThemeTokenKind;
	  }
	| {
			/** 只有颜色可以按外观区分，其余 token 只能写在 `theme`。 */
			code: "appearance-not-allowed";
			scope: "light" | "dark";
			token: string;
	  }
	| {
			/** 同一个 token 不能同时写在 `theme` 和 `light`/`dark`。 */
			code: "conflicting-scope";
			scope: "light" | "dark";
			token: string;
	  };

export type CustomThemeValidation =
	| { ok: true; tokens: CustomThemeTokens }
	| { ok: false; issues: ThemeTokenIssue[] };

const MAX_VALUE_LENGTH = 512;
const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const LENGTH = new RegExp(String.raw`^(${NUMBER})(px|rem)$`);
const PLAIN_NUMBER = new RegExp(`^${NUMBER}$`);
const HEX = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;
const COLOR_FUNCTION = /^(rgba?|hsla?)\((.*)\)$/;
// nsh 能读、但不进入自定义主题的内置写法（基础主题里用到 color-mix）。
const NATIVE_ONLY_COLOR = /^(?:color-mix|oklch|oklab|lab|lch)\(/;
const FONT_FAMILY =
	/^(?:"[^"\\]+"|'[^'\\]+'|[\p{L}\p{N}_-]+(?: [\p{L}\p{N}_-]+)*)$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNumber(text: string): number | undefined {
	return PLAIN_NUMBER.test(text) ? Number(text) : undefined;
}

/** 0–1 的数字或百分比；超出范围视为无效。 */
function parseAlpha(text: string | undefined): number | undefined {
	if (text === undefined) return 1;
	const value = text.endsWith("%")
		? parseNumber(text.slice(0, -1))
		: parseNumber(text);
	if (value === undefined) return;
	const alpha = text.endsWith("%") ? value / 100 : value;
	return alpha >= 0 && alpha <= 1 ? alpha : undefined;
}

function parsePercent(text: string): number | undefined {
	if (!text.endsWith("%")) return;
	const value = parseNumber(text.slice(0, -1));
	return value !== undefined && value >= 0 && value <= 100 ? value : undefined;
}

/** 拆分 `a b c / d` 或 `a, b, c, d`，不允许两种写法混用。 */
function splitArguments(body: string): string[] | undefined {
	const text = body.trim();
	if (text.includes(",")) {
		if (text.includes("/")) return;
		return text.split(",").map((part) => part.trim());
	}
	const [channels, alpha, ...rest] = text.split("/");
	if (rest.length > 0) return;
	const parts = channels.trim().split(/\s+/);
	if (alpha === undefined) return parts;
	return parts.length === 3 ? [...parts, alpha.trim()] : undefined;
}

function hslToRgb(hue: number, saturation: number, lightness: number) {
	const s = saturation / 100;
	const l = lightness / 100;
	const h = ((hue % 360) + 360) % 360;
	const k = (n: number) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) =>
		l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
	return [f(0), f(8), f(4)].map((channel) => channel * 255);
}

function toHex(channels: readonly number[]): string {
	return `#${channels
		.map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
		.join("")}`;
}

function parseRgbChannels(parts: readonly string[]): number[] | undefined {
	const percent = parts[0].endsWith("%");
	const channels: number[] = [];
	for (const part of parts) {
		if (part.endsWith("%") !== percent) return;
		const value = percent ? parsePercent(part) : parseNumber(part);
		if (value === undefined || value < 0 || value > (percent ? 100 : 255))
			return;
		channels.push(percent ? (value * 255) / 100 : value);
	}
	return channels;
}

function parseHslChannels(parts: readonly string[]): number[] | undefined {
	const hue = parseNumber(parts[0].replace(/deg$/, ""));
	const saturation = parsePercent(parts[1]);
	const lightness = parsePercent(parts[2]);
	if (hue === undefined || saturation === undefined || lightness === undefined)
		return;
	return hslToRgb(hue, saturation, lightness);
}

/**
 * 自定义主题接受的颜色：`#rgb[a]`/`#rrggbb[aa]`、`rgb[a]()`、`hsl[a]()`
 * （空格或逗号写法，可带透明度）和 `transparent`。返回 nsh `token()` 的
 * `#rrggbbaa` 形式；不接受的写法返回 `undefined`。
 */
export function parseThemeColor(value: string): string | undefined {
	const text = value.trim();
	if (text === "transparent") return "#00000000";
	if (HEX.test(text)) {
		const digits = text.slice(1).toLowerCase();
		const full =
			digits.length <= 4 ? [...digits].map((d) => d + d).join("") : digits;
		return `#${full.padEnd(8, "f")}`;
	}
	const match = COLOR_FUNCTION.exec(text);
	if (!match) return;
	const parts = splitArguments(match[2]);
	if (!parts || (parts.length !== 3 && parts.length !== 4)) return;
	const alpha = parseAlpha(parts[3]);
	if (alpha === undefined) return;
	const rgb = match[1].startsWith("rgb")
		? parseRgbChannels(parts.slice(0, 3))
		: parseHslChannels(parts.slice(0, 3));
	if (!rgb) return;
	return toHex([...rgb, alpha * 255]);
}

/** `px`/`rem` 非负长度，返回 nsh `token()` 的点数（1rem = 16）。 */
export function parseThemeLength(value: string): number | undefined {
	const match = LENGTH.exec(value.trim());
	if (!match) return;
	const points = Number(match[1]) * (match[2] === "rem" ? 16 : 1);
	return points >= 0 ? points : undefined;
}

/** nsh 字体 token 只读字体列表里的第一个字体（去掉引号）；WebUI 用整个列表。 */
export function nativeFontFamily(value: string): string {
	return value
		.split(",")[0]
		.trim()
		.replace(/^(["'])(.*)\1$/, "$2");
}

function isFontFamilyList(value: string): boolean {
	return value.split(",").every((family) => FONT_FAMILY.test(family.trim()));
}

function baseKind(name: string, value: string | number): ThemeTokenKind {
	if (name.startsWith("font-")) return "font";
	if (typeof value === "number") return "number";
	if (parseThemeColor(value) !== undefined || NATIVE_ONLY_COLOR.test(value))
		return name.startsWith("pilo-") ? "color" : "opaque-color";
	if (parseThemeLength(value) !== undefined) return "length";
	if (parseNumber(value) !== undefined) return "number";
	throw new Error(`Unsupported base theme token --${name}: ${value}`);
}

/** 从基础主题的 `cssVars` 得到可用 token 及取值类型。 */
export function createThemeTokenCatalog(base: ThemeCssVars): ThemeTokenCatalog {
	const catalog = new Map<string, ThemeTokenKind>();
	for (const scope of THEME_TOKEN_SCOPES) {
		for (const [name, value] of Object.entries(base[scope] ?? {})) {
			const kind = baseKind(name, value);
			const known = catalog.get(name);
			if (known !== undefined && known !== kind)
				throw new Error(
					`Base theme token --${name} is both ${known} and ${kind}`,
				);
			catalog.set(name, kind);
		}
	}
	return catalog;
}

export function isValidThemeTokenValue(
	kind: ThemeTokenKind,
	value: string,
): boolean {
	if (value.length === 0 || value.length > MAX_VALUE_LENGTH) return false;
	if (value !== value.trim()) return false;
	switch (kind) {
		case "color":
			return parseThemeColor(value) !== undefined;
		case "opaque-color":
			return parseThemeColor(value)?.endsWith("ff") === true;
		case "length":
			return parseThemeLength(value) !== undefined;
		case "number":
			return parseNumber(value) !== undefined;
		case "font":
			return isFontFamilyList(value);
	}
}

/**
 * 校验未知来源（存储、编辑器、Host 推送）的自定义主题。任何一处无效都整体拒绝，
 * 并列出全部问题：nsh `setTheme` 遇到一个读不了的值就会整体失败。
 */
export function validateCustomThemeTokens(
	input: unknown,
	catalog: ThemeTokenCatalog,
): CustomThemeValidation {
	if (!isRecord(input))
		return { ok: false, issues: [{ code: "not-an-object" }] };
	const issues: ThemeTokenIssue[] = [];
	const tokens: CustomThemeTokens = {};
	for (const scope of Object.keys(input)) {
		if (!(THEME_TOKEN_SCOPES as readonly string[]).includes(scope))
			issues.push({ code: "unknown-scope", scope });
	}
	for (const scope of THEME_TOKEN_SCOPES) {
		const entries = input[scope];
		if (entries === undefined) continue;
		if (!isRecord(entries)) {
			issues.push({ code: "not-an-object", scope });
			continue;
		}
		const valid: Record<string, string> = {};
		for (const [token, value] of Object.entries(entries)) {
			const kind = catalog.get(token);
			if (kind === undefined) {
				issues.push({ code: "unknown-token", scope, token });
			} else if (scope !== "theme" && !isColorKind(kind)) {
				issues.push({ code: "appearance-not-allowed", scope, token });
			} else if (
				scope !== "theme" &&
				isRecord(input.theme) &&
				Object.hasOwn(input.theme, token)
			) {
				issues.push({ code: "conflicting-scope", scope, token });
			} else if (
				typeof value !== "string" ||
				!isValidThemeTokenValue(kind, value)
			) {
				issues.push({ code: "invalid-value", scope, token, expected: kind });
			} else {
				valid[token] = value;
			}
		}
		if (Object.keys(valid).length > 0) tokens[scope] = valid;
	}
	return issues.length > 0 ? { ok: false, issues } : { ok: true, tokens };
}

/**
 * 把校验过的自定义 token 叠到基础主题上，得到可直接交给 nsh `setTheme` 的
 * `cssVars`。覆盖顺序与 WebUI 的 CSS 一致：自定义 `theme`/`light` 覆盖基础主题
 * 的两种外观，自定义 `dark` 只覆盖暗色。
 */
export function resolveCustomTheme(
	base: ThemeCssVars,
	custom: CustomThemeTokens,
): ThemeCssVars {
	const light = {
		...base.theme,
		...base.light,
		...custom.theme,
		...custom.light,
	};
	const dark = {
		...base.theme,
		...base.light,
		...base.dark,
		...custom.theme,
		...custom.light,
		...custom.dark,
	};
	const resolved: Required<ThemeCssVars> = { theme: {}, light: {}, dark: {} };
	for (const [name, value] of Object.entries(dark)) {
		if (Object.hasOwn(light, name) && light[name] === value)
			resolved.theme[name] = value;
		else resolved.dark[name] = value;
	}
	for (const [name, value] of Object.entries(light)) {
		if (!Object.hasOwn(resolved.theme, name)) resolved.light[name] = value;
	}
	return resolved;
}
