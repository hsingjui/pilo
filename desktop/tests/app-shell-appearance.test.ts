import { expect, open, test } from "nsh/test";

import type { PreferencePatch } from "@shared/host-preferences-types";
import type { ThemeSettings } from "@shared/theme-settings-types";

const LODY = { light: "#ffffffff", dark: "#101010ff" };
const CLAUDE = { light: "#fcfcfcff", dark: "#151515ff" };

async function openSaved(
	locale: string,
	theme: Partial<ThemeSettings>,
	colorScheme: "light" | "dark" = "light",
	fonts: PreferencePatch = {},
) {
	const app = await open("./app-shell-appearance-fixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 720,
		locale: "en-US",
		colorScheme,
		storage: {
			"fixture.locale": locale,
			"fixture.theme": JSON.stringify(theme),
			"fixture.fonts": JSON.stringify(fonts),
		},
	});
	await app.waitFor("id:workspace-title");
	return app;
}

type App = Awaited<ReturnType<typeof openSaved>>;

const background = (app: App) => app.viewStyle("id:app")?.backgroundColor;

/** The fonts the theme holds, as the fixture's line under the shell names them. */
const fonts = (app: App) =>
	app.texts().find((text) => text.startsWith("page "));

/**
 * Checks what a saved change leads to. The change reaches the shell as a
 * runtime event after the press has returned, so the check waits for it;
 * a change that never arrives fails on the value still shown.
 */
async function becomes(
	app: App,
	read: (app: App) => string | null | undefined,
	expected: string,
) {
	await app.waitUntil(() => read(app) === expected).catch(() => {});
	expect(read(app)).toBe(expected);
}

test("the shell shows the saved language and theme instead of the system's", async () => {
	const app = await openSaved("zh-CN", {
		theme: "dark",
		themeFamily: "claude",
	});
	await app.waitFor("id:workspace >> text:请先添加项目");
	expect(background(app)).toBe(CLAUDE.dark);
	expect(app.shows("text:Add a project first")).toBe(false);
});

test("the shell follows saved language and theme changes while it runs", async () => {
	const app = await openSaved("zh-CN", {
		theme: "dark",
		themeFamily: "claude",
	});
	await app.waitFor("id:workspace >> text:请先添加项目");

	await app.press("Save English");
	await app.waitFor("id:workspace >> text:Add a project first");
	await becomes(app, background, CLAUDE.dark);

	await app.press("Save Lody light");
	await becomes(app, background, LODY.light);
	expect(app.shows("id:workspace >> text:Add a project first")).toBe(true);
});

test("a saved system appearance follows the system in the saved theme", async () => {
	const app = await openSaved(
		"en-US",
		{ theme: "light", themeFamily: "lody" },
		"dark",
	);
	expect(background(app)).toBe(LODY.light);

	await app.press("Save Claude system");
	await becomes(app, background, CLAUDE.dark);
	await app.setColorScheme("light");
	await becomes(app, background, CLAUDE.light);
});

test("a saved custom theme applies over Lody, and an invalid one leaves Lody", async () => {
	const app = await openSaved("en-US", {
		theme: "light",
		themeFamily: "custom",
		themeCustomTokens: { light: { background: "#fafaf0" } },
	});
	expect(background(app)).toBe("#fafaf0ff");

	await app.press("Save Claude system");
	await becomes(app, background, CLAUDE.light);
	await app.press("Save invalid custom");
	await becomes(app, background, LODY.light);
	await app.press("Save custom");
	await becomes(app, background, "#102030ff");
});

test("a custom theme saved without tokens shows Lody", async () => {
	const app = await openSaved("en-US", {
		theme: "dark",
		themeFamily: "custom",
	});
	expect(background(app)).toBe(LODY.dark);
});

test("the shell shows the saved fonts instead of the theme's", async () => {
	const app = await openSaved(
		"en-US",
		{ theme: "light", themeFamily: "claude" },
		"light",
		{ pageFontFamily: "Georgia", codeFontFamily: "Menlo", codeFontSize: 16 },
	);
	expect(background(app)).toBe(CLAUDE.light);
	expect(fonts(app)).toBe("page Georgia, code Menlo 16, display Copernicus");
});

test("the shell follows saved font changes in the theme it shows", async () => {
	const app = await openSaved("en-US", { theme: "light", themeFamily: "lody" });
	expect(fonts(app)).toBe("page Inter, code JetBrains Mono 14, display Inter");

	await app.press("Save Georgia and Menlo");
	await becomes(app, fonts, "page Georgia, code Menlo 16, display Georgia");

	await app.press("Save Claude system");
	await becomes(app, fonts, "page Georgia, code Menlo 16, display Copernicus");

	await app.press("Save system fonts");
	await becomes(
		app,
		fonts,
		"page system, code ui-monospace 16, display Copernicus",
	);
	await app.press("Save Lody light");
	await becomes(
		app,
		fonts,
		"page system, code ui-monospace 16, display system",
	);
	await becomes(app, background, LODY.light);
});

test("saved fonts replace a custom theme's, and its display font stays", async () => {
	const app = await openSaved("en-US", { theme: "light", themeFamily: "lody" });
	await app.press("Save custom fonts");
	await becomes(
		app,
		fonts,
		"page Inter, code JetBrains Mono 14, display Times New Roman",
	);

	await app.press("Save Georgia and Menlo");
	await becomes(
		app,
		fonts,
		"page Georgia, code Menlo 16, display Times New Roman",
	);
	await app.press("Save invalid custom");
	await becomes(app, fonts, "page Georgia, code Menlo 16, display Georgia");
});
