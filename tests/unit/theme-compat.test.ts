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
} from "../../web/lib/theme-compat.ts";
import type {
	ThemeSettings,
	ThemeSettingsUpdate,
} from "../../shared/theme-settings-types.ts";

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
		assert.deepEqual(compatibleThemeUpdate(update, true), update);
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

test("token save and selection payloads leave CSS preservation to the Host", () => {
	const tokens = { light: { primary: "#fff" } };
	const updates: ThemeSettingsUpdate[] = [
		{ saveCustomTheme: { name: "Green", tokens } },
		{ saveCustomTheme: { name: "New name", tokens } },
		{
			themeFamily: "custom",
			themeCustomName: "Green",
			themeCustomTokens: tokens,
		},
		{ themeCustomTokens: tokens },
	];
	for (const update of updates) {
		const payload = compatibleThemeUpdate(update, true);
		assert.equal(Object.hasOwn(payload, "themeCustomCss"), false);
		assert.equal(Object.hasOwn(payload.saveCustomTheme ?? {}, "css"), false);
		assert.deepEqual(payload, update);
	}
	const wipe = { saveCustomTheme: { name: "Green", css: "", tokens } };
	assert.deepEqual(compatibleThemeUpdate(wipe, true), wipe);
	assert.deepEqual(compatibleThemeUpdate(wipe, false), {
		saveCustomTheme: { name: "Green", css: "" },
	});
});

test("conversion diagnostics are read-only and excluded from every outgoing mode", () => {
	const themeCustomConversion = {
		current: [{ kind: "rule", reason: "malformed", text: "bad {" }],
		savedThemes: [],
	} as const;
	// Host diagnostics may accompany a structurally typed update at runtime.
	const conversion = {
		current: [...themeCustomConversion.current],
		savedThemes: [],
	};
	for (const tokens of [false, true]) {
		for (const update of [
			{ theme: "light" } as const,
			{ themeCustomTokens: {} },
			{ saveCustomTheme: { name: "Green", css: ":root{}", tokens: {} } },
			{ deleteCustomTheme: "Green" },
		]) {
			assert.equal(
				Object.hasOwn(
					compatibleThemeUpdate(
						{ ...update, themeCustomConversion: conversion },
						tokens,
					),
					"themeCustomConversion",
				),
				false,
			);
		}
	}
	assert.equal(
		Object.hasOwn(
			legacyThemeInitial({ ...legacy, themeCustomConversion: conversion }),
			"themeCustomConversion",
		),
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
	assert.ok(html.indexOf("<script>") < html.indexOf("/web/main.tsx"));
	assert.doesNotMatch(script, /\bimport\b|\bawait\b/);
	for (const cached of [
		legacy,
		{ ...legacy, themeCustomTokens: {} },
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
