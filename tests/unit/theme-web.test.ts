import assert from "node:assert/strict";
import test from "node:test";
import {
	renderCustomThemeCss,
	CUSTOM_THEME_CATALOG,
	readCustomThemeTokens,
	validateWebThemeTokens,
} from "../../src/lib/theme-web.ts";
import mapping from "../../src/lib/theme-web-map.json" with { type: "json" };
import { readSavedCustomThemes } from "../../src/lib/theme-custom.ts";
import { readCachedTheme } from "../../src/lib/theme-settings.ts";
import { normalizeThemeSettings } from "../../src/lib/theme-compat.ts";

test("stored tables recover valid entries without relaxing update validation", () => {
	const input = {
		theme: {
			primary: "#fff",
			unknown: "1px",
			"font-sans": "Arial",
			"pilo-bubble-radius": "bad",
		},
		light: {
			primary: "#000",
			background: "#123",
			"font-sans": "Arial",
			border: "bad",
		},
		dark: { primary: "#123", background: "#456", "pilo-bubble-radius": "12px" },
	};
	const expected = {
		theme: { primary: "#fff", "font-sans": "Arial" },
		light: { background: "#123" },
		dark: { background: "#456" },
	};
	assert.deepEqual(readCustomThemeTokens(input), expected);
	assert.equal(validateWebThemeTokens(input).ok, false);
	assert.equal(renderCustomThemeCss(input), "");
	assert.deepEqual(
		readSavedCustomThemes([{ name: "Partial", tokens: input }])[0].tokens,
		expected,
	);
	assert.deepEqual(
		normalizeThemeSettings({
			revision: 1,
			theme: "light",
			themeFamily: "custom",
			themeCustomCss: "",
			themeCustomName: "",
			savedCustomThemes: [],
			themeCustomTokens: input,
		}).themeCustomTokens,
		expected,
	);
});

test("stored tables ignore malformed containers and keep valid sibling scopes", () => {
	for (const input of [undefined, null, [], "bad", 4])
		assert.deepEqual(readCustomThemeTokens(input), {});
	assert.deepEqual(
		readCustomThemeTokens({
			theme: [],
			light: null,
			dark: { primary: "#fff", border: 5 },
			other: { primary: "#000" },
		}),
		{ dark: { primary: "#fff" } },
	);
	assert.deepEqual(
		readCustomThemeTokens({
			theme: { primary: "#ffffff80", background: "#fff" },
		}),
		{ theme: { background: "#fff" } },
	);
});

test("maps every catalog token and reverses fonts", () => {
	for (const [token, entry] of Object.entries(mapping)) {
		if (entry.format === "hsl-channels")
			assert.equal(CUSTOM_THEME_CATALOG.get(token), "opaque-color", token);
	}
	assert.deepEqual(
		new Set(Object.keys(mapping)),
		new Set(CUSTOM_THEME_CATALOG.keys()),
	);
	assert.equal(
		renderCustomThemeCss({
			theme: { "font-sans": "Arial, sans-serif", "pilo-bubble-radius": "12px" },
		}),
		':root[data-theme-family="custom"]{--pilo-page-font-family:Arial, sans-serif;--pilo-bubble-radius:12px;}',
	);
});

test("light applies to both appearances and dark overrides only dark", () => {
	assert.equal(
		renderCustomThemeCss({
			light: { primary: "#ff0000" },
			dark: { primary: "rgb(0 0 255)" },
		}),
		':root[data-theme-family="custom"]{--primary:0 100% 50%;}.dark:root[data-theme-family="custom"]{--primary:240 100% 50%;}',
	);
	assert.equal(
		renderCustomThemeCss({ theme: { primary: "hsl(120 100% 50%)" } }),
		':root[data-theme-family="custom"]{--primary:120 100% 50%;}',
	);
});

test("invalid and empty tables emit no CSS", () => {
	for (const value of [
		{},
		undefined,
		null,
		{ theme: { unknown: "1px" } },
		{ theme: { primary: "red; color:red" } },
	])
		assert.equal(renderCustomThemeCss(value), "");
});

test("saved themes tolerate old Host fields and reject invalid token tables", () => {
	assert.deepEqual(
		readSavedCustomThemes([
			{ name: "old", css: "body{}" },
			{ name: "new", tokens: { light: { primary: "#fff" } } },
			{ name: "invalid", tokens: { theme: { nope: "1" } } },
		]),
		[
			{ name: "old", css: "body{}", tokens: {} },
			{ name: "new", css: "", tokens: { light: { primary: "#fff" } } },
			{ name: "invalid", css: "", tokens: {} },
		],
	);
	assert.deepEqual(readSavedCustomThemes(null), []);
});

test("cached settings normalize missing and invalid token fields", () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	let cache = "{}";
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => (key === "pilo.theme.v1" ? cache : null),
		},
	});
	try {
		assert.equal(
			Object.hasOwn(readCachedTheme("system"), "themeCustomTokens"),
			false,
		);
		cache = JSON.stringify({
			themeCustomTokenCss: "",
			themeCustomTokens: { light: { primary: "#fff" } },
		});
		assert.deepEqual(readCachedTheme("system").themeCustomTokens, {
			light: { primary: "#fff" },
		});
		cache = JSON.stringify({
			themeCustomTokenCss: "",
			themeCustomTokens: { theme: { primary: "bad" } },
		});
		assert.deepEqual(readCachedTheme("system").themeCustomTokens, {});
		cache = JSON.stringify({
			themeCustomCss: ":root{--primary:120 60% 40%;}",
			themeCustomTokens: {},
		});
		assert.equal(
			Object.hasOwn(readCachedTheme("system"), "themeCustomTokens"),
			false,
		);
		assert.equal(
			readCachedTheme("system").themeCustomCss,
			":root{--primary:120 60% 40%;}",
		);
	} finally {
		if (original) Object.defineProperty(globalThis, "localStorage", original);
		else Reflect.deleteProperty(globalThis, "localStorage");
	}
});
