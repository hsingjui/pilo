import assert from "node:assert/strict";
import test from "node:test";
import {
	renderCustomThemeCss,
	validateWebThemeAlpha,
	CUSTOM_THEME_CATALOG,
} from "../../src/lib/theme-web.ts";
import mapping from "../../src/lib/theme-web-map.json" with { type: "json" };
import { readSavedCustomThemes } from "../../src/lib/theme-custom.ts";
import { readCachedTheme } from "../../src/lib/theme-settings.ts";

test("maps every catalog token and reverses fonts", () => {
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

test("alpha on channel triples is rejected separately", () => {
	assert.deepEqual(validateWebThemeAlpha({ light: { primary: "#ff000080" } }), [
		{ code: "alpha-not-supported", scope: "light", token: "primary" },
	]);
	assert.deepEqual(
		validateWebThemeAlpha({ light: { primary: "#ff0000" } }),
		[],
	);
	assert.equal(renderCustomThemeCss({ light: { primary: "transparent" } }), "");
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
		assert.deepEqual(readCachedTheme("system").themeCustomTokens, {});
		cache = JSON.stringify({
			themeCustomTokens: { light: { primary: "#fff" } },
		});
		assert.deepEqual(readCachedTheme("system").themeCustomTokens, {
			light: { primary: "#fff" },
		});
		cache = JSON.stringify({
			themeCustomTokens: { theme: { primary: "bad" } },
		});
		assert.deepEqual(readCachedTheme("system").themeCustomTokens, {});
	} finally {
		if (original) Object.defineProperty(globalThis, "localStorage", original);
		else Reflect.deleteProperty(globalThis, "localStorage");
	}
});
