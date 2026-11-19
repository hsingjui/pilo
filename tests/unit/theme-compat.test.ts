import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
	compatibleThemeUpdate,
	customThemeCss,
	legacyThemeInitial,
	normalizeThemeSettings,
	supportsThemeTokens,
} from "../../src/lib/theme-compat.ts";
import type {
	ThemeSettings,
	ThemeSettingsUpdate,
} from "../../src/lib/theme-settings-types.ts";

const legacy: ThemeSettings = {
	revision: 4,
	theme: "dark",
	themeFamily: "custom",
	themeCustomCss: ":root{--primary:120 60% 40%;}",
	themeCustomName: "Green",
	savedCustomThemes: [{ name: "Green", css: ":root{}" }],
};

test("Host field presence, not a synthesized default, enables token rendering", () => {
	assert.equal(supportsThemeTokens(normalizeThemeSettings(legacy)), false);
	assert.equal(
		customThemeCss(normalizeThemeSettings(legacy)),
		legacy.themeCustomCss,
	);
	const capable = {
		...legacy,
		themeCustomTokens: { light: { primary: "#ff0000" } },
	};
	assert.equal(supportsThemeTokens(capable), true);
	assert.match(customThemeCss(capable), /--primary:0 100% 50%/);
	assert.equal(customThemeCss({ ...legacy, themeFamily: "lody" }), "");
	assert.equal(customThemeCss({ ...legacy, themeCustomTokens: {} }), "");
});

test("invalid tokens alone are dropped without discarding revision or other settings", () => {
	const next = {
		...legacy,
		themeCustomTokens: { light: { primary: "invalid" } },
	};
	assert.deepEqual(normalizeThemeSettings(next), {
		...next,
		themeCustomTokens: {},
		savedCustomThemes: [{ name: "Green", css: ":root{}", tokens: {} }],
	});
});

test("all legacy updates and initial migration omit token keys", () => {
	const updates: ThemeSettingsUpdate[] = [
		{ theme: "light" },
		{ themeFamily: "lody" },
		{
			themeFamily: "custom",
			themeCustomCss: legacy.themeCustomCss,
			themeCustomTokens: {},
			themeCustomName: "Green",
		},
		{
			themeFamily: "custom",
			saveCustomTheme: {
				name: "Green",
				css: legacy.themeCustomCss,
				tokens: { light: { primary: "#fff" } },
			},
		},
		{ deleteCustomTheme: "Green" },
		{},
	];
	for (const update of updates) {
		const payload = compatibleThemeUpdate(update, false);
		assert.equal(Object.hasOwn(payload, "themeCustomTokens"), false);
		assert.equal(Object.hasOwn(payload.saveCustomTheme ?? {}, "tokens"), false);
		assert.equal(compatibleThemeUpdate(update, true), update);
	}
	assert.deepEqual(compatibleThemeUpdate(updates[3], false), {
		themeFamily: "custom",
		saveCustomTheme: { name: "Green", css: legacy.themeCustomCss },
	});
	assert.equal(
		JSON.stringify(
			legacyThemeInitial({
				...legacy,
				themeCustomTokens: {},
				savedCustomThemes: [{ name: "Green", css: "", tokens: {} }],
			}),
		).includes("tokens"),
		false,
	);
});

test("boot is inline classic before the bundle and injects cached CSS synchronously in both modes", () => {
	const html = readFileSync(
		new URL("../../index.html", import.meta.url),
		"utf8",
	);
	const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
	assert.ok(script);
	assert.ok(html.indexOf("<script>") < html.indexOf("/src/main.tsx"));
	assert.doesNotMatch(script, /\bimport\b|\bawait\b/);
	for (const cached of [
		legacy,
		{
			...legacy,
			themeCustomTokens: {},
			themeCustomTokenCss:
				':root[data-theme-family="custom"]{--primary:120 60% 40%;}',
		},
		{ ...legacy, themeCustomCss: "" },
	]) {
		const styles: { textContent: string }[] = [];
		const root = {
			style: { setProperty() {} },
			classList: { add() {} },
			dataset: {},
			setAttribute() {},
		};
		runInNewContext(script, {
			localStorage: {
				getItem: (key: string) =>
					({
						"pilo.theme.v1": JSON.stringify(cached),
						"pilo-ui-theme-family": "custom",
						"pilo-ui-theme": "dark",
					})[key] ?? null,
			},
			document: {
				documentElement: root,
				head: { appendChild: (el: { textContent: string }) => styles.push(el) },
				createElement: () => ({}),
				querySelector: () => null,
			},
			window: { matchMedia: () => ({ matches: false }) },
			navigator: { platform: "MacIntel" },
			getComputedStyle: () => ({ getPropertyValue: () => "" }),
		});
		const expected =
			"themeCustomTokenCss" in cached
				? cached.themeCustomTokenCss
				: cached.themeCustomCss;
		assert.equal(styles[0]?.textContent ?? "", expected);
	}
});
