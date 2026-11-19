import { expect, open, test } from "nsh/test";

test("a validated custom theme applies over Lody with every accepted value form", async () => {
	const app = await open("./custom-theme-fixture.tsx", {
		colorScheme: "light",
	});
	await app.press("Apply custom");
	expect(app.shows("text:applied")).toBe(true);
	await app.press("Check light");
	expect(app.texts()).toContain("light matches");
	// Lody 的背景没被自定义 token 覆盖，仍然生效。
	expect(app.viewStyle("id:surface")?.backgroundColor).toBe("#ffffffff");

	await app.setColorScheme("dark");
	await app.press("Check dark");
	expect(app.texts()).toContain("dark matches");
	expect(app.viewStyle("id:surface")?.backgroundColor).toBe("#101010ff");
});

test("an invalid custom theme is rejected and the applied one stays", async () => {
	const app = await open("./custom-theme-fixture.tsx", {
		colorScheme: "light",
	});
	await app.press("Apply custom");
	await app.press("Apply invalid");
	expect(app.texts()).toContain("rejected invalid-value");
	await app.press("Check light");
	expect(app.texts()).toContain("light matches");
});
