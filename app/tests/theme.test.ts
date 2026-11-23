import { expect, open, test } from "nsh/test";

test("Lody background follows the app appearance", async () => {
	const app = await open("./app-shell-fixture.tsx", { colorScheme: "light" });
	await app.waitFor("id:app");
	expect(app.viewStyle("id:app")?.backgroundColor).toBe("#ffffffff");
	await app.setColorScheme("dark");
	expect(app.viewStyle("id:app")?.backgroundColor).toBe("#101010ff");
});

test("generated themes apply at runtime without losing native tokens", async () => {
	const app = await open("./theme-fixture.tsx", { colorScheme: "light" });
	expect(app.viewStyle("id:surface")?.backgroundColor).toBe("#ffffffff");
	expect(app.shows("text:ready")).toBe(true);
	expect(app.shows("text:Sheet radius: 8")).toBe(true);
	expect(app.shows("text:Font: Inter")).toBe(true);

	await app.press("Apply Claude");
	expect(app.viewStyle("id:surface")?.backgroundColor).toBe("#fcfcfcff");
	expect(app.shows("text:ready")).toBe(true);
	await app.setColorScheme("dark");
	expect(app.viewStyle("id:surface")?.backgroundColor).toBe("#151515ff");
	expect(app.shows("text:ready")).toBe(true);

	await app.press("Restore Lody");
	expect(app.viewStyle("id:surface")?.backgroundColor).toBe("#101010ff");
	expect(app.shows("text:ready")).toBe(true);
});
