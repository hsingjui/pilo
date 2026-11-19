import { expect, open, test } from "nsh/test";
import lody from "../theme.json";
import claude from "../claude-theme.json";

test("Button renders every variant and size with token geometry, including empty and icon buttons", async () => {
	const app = await open("./ui-button-fixture.tsx", {
		colorScheme: "light",
		platform: "macos",
		width: 1100,
		height: 900,
	});
	for (const variant of [
		"default",
		"secondary",
		"destructive",
		"outline",
		"ghost",
		"link",
	]) {
		for (const size of ["default", "sm", "lg", "icon"]) {
			expect(app.shows(`id:${variant}-${size}`)).toBe(true);
		}
	}
	expect(app.enabled("id:empty")).toBe(true);
	await app.press("id:measure");
	expect(app.shows("text:All 24 button sizes match")).toBe(true);
	expect(app.shows("text:All row centers align")).toBe(true);
	expect(app.viewStyle("id:custom")?.backgroundColor).toBe("#123456ff");
	expect(app.viewStyle("id:custom")?.opacity).toBeGreaterThan(0.799);
	expect(app.viewStyle("id:custom")?.opacity).toBeLessThan(0.801);
});

test("Button fires onPress and disabled buttons reject presses without firing", async () => {
	const app = await open("./ui-button-fixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 900,
	});
	await app.press("id:press");
	expect(app.shows("text:Pressed: 1")).toBe(true);
	expect(app.enabled("id:disabled")).toBe(false);
	expect(app.viewStyle("id:disabled")?.opacity).toBe(0.5);
	await expect(app.press("id:disabled")).rejects.toMatchObject({
		code: "ERR_NSH_TEST_DISABLED",
	});
	expect(app.shows("text:Pressed: 1")).toBe(true);
});

test("Button backgrounds follow theme JSON values, hover states and runtime Claude themes", async () => {
	const app = await open("./ui-button-fixture.tsx", {
		colorScheme: "light",
		platform: "macos",
		width: 1100,
		height: 900,
	});
	const lodyPrimary = app.viewStyle("id:default-default")?.backgroundColor;
	for (const [variant, token] of [
		["default", "primary"],
		["secondary", "button-secondary"],
		["destructive", "destructive"],
	]) {
		expect(app.viewStyle(`id:${variant}-default`)?.backgroundColor).toBe(
			app.viewStyle(`id:reference-${token}`)?.backgroundColor,
		);
	}
	await app.hover("id:default-default");
	expect(app.viewStyle("id:default-default")?.backgroundColor).toBe(
		app.viewStyle("id:reference-button-hover")?.backgroundColor,
	);
	await app.hover("id:secondary-default");
	expect(app.viewStyle("id:secondary-default")?.backgroundColor).toBe(
		app.viewStyle("id:reference-button-secondary-hover")?.backgroundColor,
	);
	await app.hover("id:ghost-default");
	expect(app.viewStyle("id:ghost-default")?.backgroundColor).toBe(
		app.viewStyle("id:reference-hover")?.backgroundColor,
	);
	await app.hover("id:claude");
	await app.press("id:claude");
	expect(app.viewStyle("id:default-default")?.backgroundColor).not.toBe(
		lodyPrimary,
	);
	expect(app.viewStyle("id:default-default")?.backgroundColor).toBe(
		app.viewStyle("id:reference-primary")?.backgroundColor,
	);
	expect(
		app.shows(
			`text:Shadow: ${claude.styleVars.theme["pilo-button-primary-shadow"]}`,
		),
	).toBe(true);
	await app.setColorScheme("dark");
	expect(app.viewStyle("id:default-default")?.backgroundColor).toBe(
		app.viewStyle("id:reference-primary")?.backgroundColor,
	);
	await app.press("id:restore");
	expect(
		app.shows(
			`text:Shadow: ${lody.styleVars.theme["pilo-button-primary-shadow"]}`,
		),
	).toBe(true);
	await app.setColorScheme("light");
	expect(app.viewStyle("id:default-default")?.backgroundColor).toBe(
		lodyPrimary,
	);
});

test("Button provides variant foregrounds to decorative icons and follows runtime theme changes", async () => {
	const app = await open("./ui-button-fixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 900,
	});
	for (const theme of ["lody", "claude"]) {
		if (theme === "claude") await app.press("id:claude");
		for (const [variant, name] of [
			["default", "primary-foreground"],
			["secondary", "button-secondary-foreground"],
			["destructive", "destructive-foreground"],
			["outline", "foreground"],
			["ghost", "foreground"],
			["link", "primary"],
		]) {
			expect(app.viewStyle(`id:foreground-${variant}`)?.backgroundColor).toBe(
				app.viewStyle(`id:reference-${name}`)?.backgroundColor,
			);
		}
	}
});
