import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	createThemeTokenCatalog,
	isColorKind,
	isValidThemeTokenValue,
	nativeFontFamily,
	parseThemeColor,
	parseThemeLength,
	resolveCustomTheme,
	validateCustomThemeTokens,
	type ThemeCssVars,
} from "../../shared/theme-tokens.ts";

const base: ThemeCssVars = {
	theme: {
		"font-sans": '"Inter", system-ui, sans-serif',
		"pilo-bubble-radius": "1rem",
		"z-dialog": "80",
		"pilo-menu-checked-background": "transparent",
	},
	light: {
		primary: "hsl(225 7.1% 11%)",
		ring: "color-mix(in oklab, hsl(0 0% 0%) 20%, hsl(0 0% 100%) 80%)",
	},
	dark: { primary: "hsl(0 0% 100%)", ring: "hsl(0 0% 50%)" },
};
const catalog = createThemeTokenCatalog(base);

function readJson(path: string): { cssVars: ThemeCssVars } {
	return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

test("the catalog takes each base token's kind from its value", () => {
	assert.deepEqual(Object.fromEntries(catalog), {
		"font-sans": "font",
		"pilo-bubble-radius": "length",
		"z-dialog": "number",
		"pilo-menu-checked-background": "color",
		primary: "opaque-color",
		ring: "opaque-color",
	});
	assert.throws(
		() => createThemeTokenCatalog({ theme: { "pilo-padding": "1px 2px" } }),
		/Unsupported base theme token --pilo-padding/,
	);
});

test("the generated Lody theme yields a catalog", () => {
	const lody = createThemeTokenCatalog(
		readJson("../../theme/theme.json").cssVars,
	);
	assert.equal(lody.get("primary"), "opaque-color");
	assert.equal(lody.get("pilo-menu-checked-background"), "color");
	assert.equal(lody.get("pilo-composer-radius"), "length");
	assert.equal(lody.get("pilo-mobile-button-height"), "length");
	assert.equal(lody.get("font-mono"), "font");
	assert.equal(lody.get("z-tooltip"), "number");
	// 阴影、动效和简写只在 styleVars 里，不能出现在自定义主题中。
	assert.equal(lody.has("pilo-sidebar-shadow"), false);
	assert.equal(lody.has("pilo-sidebar-padding"), true);
	assert.equal(lody.has("dur-1"), false);
});

test("colors parse to nsh's #rrggbbaa form", () => {
	const cases: Record<string, string> = {
		"#abc": "#aabbccff",
		"#ABCD": "#aabbccdd",
		"#12abEF": "#12abefff",
		"#12abef80": "#12abef80",
		transparent: "#00000000",
		"rgb(255 0 128)": "#ff0080ff",
		"rgb(255, 0, 128)": "#ff0080ff",
		"rgba(255, 0, 128, 0.5)": "#ff008080",
		"rgb(100% 0% 50% / 50%)": "#ff008080",
		"hsl(0 100% 50%)": "#ff0000ff",
		"hsl(120deg 100% 25%)": "#008000ff",
		"hsl(225 7.1% 11%)": "#1a1b1eff",
		"hsla(240, 100%, 50%, 0.25)": "#0000ff40",
		"hsl(14 61.7% 47% / 0.1)": "#c2502e1a",
	};
	for (const [input, expected] of Object.entries(cases))
		assert.equal(parseThemeColor(input), expected, input);
});

test("color forms nsh or the WebUI cannot both read are rejected", () => {
	for (const input of [
		"red",
		"#abcde",
		"#ggg",
		"hsl(14 61.7 47%)",
		"hsl(14 120% 47%)",
		"rgb(256 0 0)",
		"rgb(255 0% 0)",
		"rgb(255, 0 0)",
		"rgb(255, 0, 0 / 0.5)",
		"rgba(0, 0, 0, 2)",
		"HSL(0 0% 0%)",
		"var(--primary)",
		"color-mix(in oklab, red 50%, blue 50%)",
		"oklch(0.5 0.1 200)",
		"14 61.7% 47%",
	])
		assert.equal(parseThemeColor(input), undefined, input);
});

test("HSL channel colors take no alpha, full --pilo-* colors do", () => {
	for (const value of ["#c2512e", "#c2512eff", "hsl(14 61.7% 47% / 1)"])
		assert.equal(isValidThemeTokenValue("opaque-color", value), true, value);
	for (const value of ["#c2512e80", "rgba(0, 0, 0, 0.5)", "transparent"]) {
		assert.equal(isValidThemeTokenValue("opaque-color", value), false, value);
		assert.equal(isValidThemeTokenValue("color", value), true, value);
	}
	assert.deepEqual(
		validateCustomThemeTokens({ light: { primary: "#c2512e80" } }, catalog),
		{
			ok: false,
			issues: [
				{
					code: "invalid-value",
					scope: "light",
					token: "primary",
					expected: "opaque-color",
				},
			],
		},
	);
});

test("opaque colors are exactly the tokens the WebUI CSS holds as HSL channels", () => {
	const channels = /^-?[\d.]+(?:deg)?\s+[\d.]+%\s+[\d.]+%$/;
	const lodySource = readFileSync(
		new URL("../../theme/lody-theme.css", import.meta.url),
		"utf8",
	).replace(/\/\*[\s\S]*?\*\//g, "");
	for (const [css, json] of [
		["lody-theme.css", "theme.json"],
		["claude-theme.css", "claude-theme.json"],
		["grove-theme.css", "grove-theme.json"],
		["ocean-theme.css", "ocean-theme.json"],
		["ember-theme.css", "ember-theme.json"],
		["iris-theme.css", "iris-theme.json"],
	]) {
		const ownSource =
			css === "lody-theme.css"
				? lodySource
				: `${lodySource}\n${readFileSync(
						new URL(`../../theme/${css}`, import.meta.url),
						"utf8",
					).replace(/\/\*[\s\S]*?\*\//g, "")}`;
		const raw = new Map<string, string[]>();
		for (const [, name, value] of ownSource.matchAll(
			/--([a-z\d-]+)\s*:\s*([^;]+);/g,
		))
			raw.set(name, [
				...(raw.get(name) ?? []),
				value.trim().replace(/\s+/g, " "),
			]);
		const isChannels = (name: string, seen: string[] = []): boolean => {
			const values = raw.get(name);
			if (!values || values.length === 0) return false;
			return values.every((value) => {
				const alias = /^var\(--([a-z\d-]+)\)$/.exec(value)?.[1];
				return alias && !seen.includes(alias)
					? isChannels(alias, [...seen, name])
					: channels.test(value);
			});
		};
		const themeCatalog = createThemeTokenCatalog(
			readJson(`../../theme/${json}`).cssVars,
		);
		for (const [name, kind] of themeCatalog) {
			if (!isColorKind(kind)) continue;
			assert.equal(
				kind === "opaque-color",
				isChannels(name),
				`${css} --${name}`,
			);
		}
	}
});

test("numbers that overflow to Infinity are rejected everywhere", () => {
	const huge = "9".repeat(400);
	for (const input of [
		`hsl(${huge} 50% 50%)`,
		`hsl(${huge}deg 50% 50%)`,
		`hsl(0 ${huge}% 50%)`,
		`hsl(0 50% 50% / ${huge}%)`,
		`rgb(${huge} 0 0)`,
		`rgba(0, 0, 0, ${huge})`,
	]) {
		assert.equal(parseThemeColor(input), undefined, input);
		assert.equal(isValidThemeTokenValue("opaque-color", input), false, input);
	}
	assert.equal(parseThemeLength(`${huge}px`), undefined);
	assert.equal(parseThemeLength(`${"9".repeat(308)}rem`), undefined);
	assert.equal(isValidThemeTokenValue("number", huge), false);
	assert.equal(
		parseThemeColor("hsl(-3600.5 50% 50%)"),
		parseThemeColor("hsl(359.5 50% 50%)"),
	);
});

test("lengths are non-negative px or rem, in points", () => {
	assert.equal(parseThemeLength("12px"), 12);
	assert.equal(parseThemeLength("0.75rem"), 12);
	assert.equal(parseThemeLength(".5rem"), 8);
	assert.equal(parseThemeLength("0px"), 0);
	for (const input of ["-1px", "12", "1em", "50%", "calc(1rem + 2px)", "1 px"])
		assert.equal(parseThemeLength(input), undefined, input);
});

test("nsh reads the first family of a font list, unquoted", () => {
	assert.equal(
		nativeFontFamily('"JetBrains Mono", ui-monospace'),
		"JetBrains Mono",
	);
	assert.equal(nativeFontFamily("'Fira Code', monospace"), "Fira Code");
	assert.equal(nativeFontFamily("system-ui"), "system-ui");
});

test("a valid table is returned as is, without empty scopes", () => {
	const input = {
		theme: {
			"pilo-bubble-radius": "1.25rem",
			"font-sans": "'Noto Sans SC', 微软雅黑, sans-serif",
			"z-dialog": "90",
		},
		light: { primary: "#c2512e" },
		dark: {},
	};
	assert.deepEqual(validateCustomThemeTokens(input, catalog), {
		ok: true,
		tokens: { theme: input.theme, light: input.light },
	});
	assert.deepEqual(validateCustomThemeTokens({}, catalog), {
		ok: true,
		tokens: {},
	});
});

test("every problem is reported and nothing is accepted", () => {
	const result = validateCustomThemeTokens(
		{
			theme: {
				primary: "hsl(0 0% 0%)",
				missing: "1px",
				"pilo-bubble-radius": "big",
				"font-sans": "Inter; color: red",
				"z-dialog": 80,
			},
			light: { primary: "#fff", "pilo-bubble-radius": "1rem" },
			dark: { ring: " #fff" },
			extra: {},
		},
		catalog,
	);
	assert.deepEqual(result, {
		ok: false,
		issues: [
			{ code: "unknown-scope", scope: "extra" },
			{ code: "unknown-token", scope: "theme", token: "missing" },
			{
				code: "invalid-value",
				scope: "theme",
				token: "pilo-bubble-radius",
				expected: "length",
			},
			{
				code: "invalid-value",
				scope: "theme",
				token: "font-sans",
				expected: "font",
			},
			{
				code: "invalid-value",
				scope: "theme",
				token: "z-dialog",
				expected: "number",
			},
			{ code: "conflicting-scope", scope: "light", token: "primary" },
			{
				code: "appearance-not-allowed",
				scope: "light",
				token: "pilo-bubble-radius",
			},
			{
				code: "invalid-value",
				scope: "dark",
				token: "ring",
				expected: "opaque-color",
			},
		],
	});
	assert.deepEqual(validateCustomThemeTokens("css", catalog), {
		ok: false,
		issues: [{ code: "not-an-object" }],
	});
	assert.deepEqual(validateCustomThemeTokens({ light: [] }, catalog), {
		ok: false,
		issues: [{ code: "not-an-object", scope: "light" }],
	});
	assert.equal(
		validateCustomThemeTokens(
			{ theme: { "font-sans": "x".repeat(513) } },
			catalog,
		).ok,
		false,
	);
});

test("custom tokens override the base the way the WebUI cascade does", () => {
	const resolved = resolveCustomTheme(base, {
		theme: { "pilo-bubble-radius": "2rem" },
		light: { ring: "#ff0000" },
		dark: { primary: "#00ff00" },
	});
	assert.deepEqual(resolved, {
		theme: {
			"font-sans": '"Inter", system-ui, sans-serif',
			"pilo-bubble-radius": "2rem",
			"z-dialog": "80",
			"pilo-menu-checked-background": "transparent",
			ring: "#ff0000",
		},
		light: { primary: "hsl(225 7.1% 11%)" },
		dark: { primary: "#00ff00" },
	});
	assert.deepEqual(resolveCustomTheme(base, {}), {
		theme: base.theme,
		light: base.light,
		dark: base.dark,
	});
});

function relativeLuminance(color: string): number {
	const hex = parseThemeColor(color);
	assert.ok(hex, `Expected parseable color, got ${color}`);
	const [r, g, b] = [0, 2, 4].map((offset) => {
		const channel =
			Number.parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255;
		return channel <= 0.03928
			? channel / 12.92
			: ((channel + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
	const fg = relativeLuminance(foreground);
	const bg = relativeLuminance(background);
	return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

test("built-in Grove, Ocean, Ember, and Iris themes meet WCAG AA contrast", () => {
	const pairs: readonly [string, string, number][] = [
		["foreground", "background", 7],
		["foreground", "card", 7],
		["foreground", "popover", 7],
		["foreground", "muted", 4.5],
		["foreground", "hover", 4.5],
		["card-foreground", "card", 4.5],
		["muted-foreground", "background", 4.5],
		["muted-foreground", "card", 4.5],
		["muted-foreground", "muted", 4.5],
		["muted-foreground", "hover", 4.5],
		["primary-foreground", "primary", 4.5],
		["primary-foreground", "button-hover", 4.5],
		["destructive-foreground", "destructive", 4.5],
		["tooltip-foreground", "tooltip-background", 7],
		["sidebar-foreground", "sidebar-background", 4.5],
		["sidebar-foreground-muted", "sidebar-background", 4.5],
		["sidebar-foreground-muted", "sidebar-selection", 4.5],
		["sidebar-selection-foreground", "sidebar-selection", 4.5],
		["code-foreground", "code-background", 7],
		["syntax-keyword", "code-background", 4.5],
		["syntax-string", "code-background", 4.5],
		["syntax-number", "code-background", 4.5],
		["syntax-comment", "code-background", 4.5],
		["syntax-function", "code-background", 4.5],
		["syntax-variable", "code-background", 4.5],
		["syntax-title", "code-background", 4.5],
		["syntax-attr", "code-background", 4.5],
		["syntax-builtin", "code-background", 4.5],
		["ring", "background", 3],
		["ring", "card", 3],
		["status-success", "background", 4.5],
		["status-warning", "background", 4.5],
		["status-danger", "background", 4.5],
	];

	for (const family of ["grove", "ocean", "ember", "iris"]) {
		const theme = readJson(`../../theme/${family}-theme.json`).cssVars;
		for (const mode of ["light", "dark"] as const) {
			const vars: Record<string, string | number> = {
				...theme.theme,
				...theme.light,
				...(mode === "dark" ? theme.dark : {}),
			};
			for (const [fg, bg, min] of pairs) {
				const fgValue = String(vars[fg]);
				const bgValue = String(vars[bg]);
				const ratio = contrastRatio(fgValue, bgValue);
				assert.ok(
					ratio >= min,
					`${family} (${mode}): ${fg} (${fgValue}) on ${bg} (${bgValue}) contrast ${ratio.toFixed(2)} < ${min}`,
				);
			}
		}
	}
});
