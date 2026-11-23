import { expect, open, test } from "nsh/test";

test("Tooltip shows on desktop hover and hides when the pointer leaves", async () => {
	const app = await open("./ui-tooltip-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	expect(app.shows("text:Helpful hint")).toBe(false);
	await app.hover("id:trigger");
	await app.waitFor("text:Helpful hint");
	await app.hover("id:leave");
	await app.waitUntil(() => !app.shows("text:Helpful hint"));
	await app.hover("id:disabled-trigger");
	expect(app.shows("text:Disabled hint")).toBe(false);
});

test("Tooltip follows controlled hover requests in both directions", async () => {
	const app = await open("./ui-tooltip-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	await app.hover("id:controlled");
	await app.waitFor("text:Controlled hint");
	expect(app.shows("text:Open: true")).toBe(true);
	await app.hover("id:leave");
	await app.waitUntil(() => !app.shows("text:Controlled hint"));
	expect(app.shows("text:Open: false")).toBe(true);
});

test("Tooltip uses the runtime tooltip background with a popover fallback", async () => {
	const app = await open("./ui-tooltip-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	for (const theme of ["lody", "claude"]) {
		if (theme === "claude") await app.press("id:claude");
		await app.hover("id:trigger");
		await app.waitFor("text:Helpful hint");
		expect(app.viewStyle("id:bubble")?.backgroundColor).toBe(
			app.viewStyle("id:reference-background")?.backgroundColor,
		);
		await app.hover("id:leave");
		await app.waitUntil(() => !app.shows("text:Helpful hint"));
	}
});
