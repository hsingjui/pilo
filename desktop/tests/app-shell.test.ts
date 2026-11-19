import { expect, open, test } from "nsh/test";

test("the shell renders its sidebar and workspace at desktop and narrow widths", async () => {
	const app = await open("../App.tsx", { width: 1100, height: 720 });
	expect(app.shows("id:sidebar >> text:Pilo")).toBe(true);
	expect(app.shows("id:workspace >> text:Select a project")).toBe(true);
	expect(app.shows("text:pilo-desktop")).toBe(true);
	expect(app.viewStyle("id:sidebar")?.backgroundColor).toBe("#f7f8faff");
	await app.setViewport(390, 844);
	expect(app.shows("id:sidebar >> text:Pilo")).toBe(true);
	expect(app.shows("id:workspace >> text:Select a project")).toBe(true);
});
