import { expect, open, test } from "nsh/test";

import type { ThemeSettings } from "@/lib/theme-settings-types";

const LODY = { light: "#ffffffff", dark: "#101010ff" };
const CLAUDE = { light: "#fcfcfcff", dark: "#151515ff" };

async function openSaved(
	locale: string,
	theme: Partial<ThemeSettings>,
	colorScheme: "light" | "dark" = "light",
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
		},
	});
	await app.waitFor("id:workspace-title");
	return app;
}

const background = (app: Awaited<ReturnType<typeof openSaved>>) =>
	app.viewStyle("id:app")?.backgroundColor;

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
	expect(background(app)).toBe(CLAUDE.dark);

	await app.press("Save Lody light");
	expect(background(app)).toBe(LODY.light);
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
	expect(background(app)).toBe(CLAUDE.dark);
	await app.setColorScheme("light");
	expect(background(app)).toBe(CLAUDE.light);
});

test("a saved custom theme applies over Lody, and an invalid one leaves Lody", async () => {
	const app = await openSaved("en-US", {
		theme: "light",
		themeFamily: "custom",
		themeCustomTokens: { light: { background: "#fafaf0" } },
	});
	expect(background(app)).toBe("#fafaf0ff");

	await app.press("Save Claude system");
	expect(background(app)).toBe(CLAUDE.light);
	await app.press("Save invalid custom");
	expect(background(app)).toBe(LODY.light);
	await app.press("Save custom");
	expect(background(app)).toBe("#102030ff");
});

test("a custom theme saved without tokens shows Lody", async () => {
	const app = await openSaved("en-US", {
		theme: "dark",
		themeFamily: "custom",
	});
	expect(background(app)).toBe(LODY.dark);
});
