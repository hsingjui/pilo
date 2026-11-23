import assert from "node:assert/strict";
import test from "node:test";
import {
	renderCustomThemeCss,
	CUSTOM_THEME_CATALOG,
	readCustomThemeTokens,
	validateWebThemeTokens,
} from "../../shared/theme-web.ts";
import mapping from "../../shared/theme-web-map.json" with { type: "json" };
import { readSavedCustomThemes } from "../../shared/theme-custom.ts";

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
