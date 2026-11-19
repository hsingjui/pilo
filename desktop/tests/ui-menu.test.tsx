import { expect, open, test } from "nsh/test";

test("Menu selects and closes, ignores disabled items, and dismisses with Escape", async () => {
	const app = await open("./ui-menu-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	expect(app.shows("text:New session")).toBe(false);
	await app.press("id:trigger");
	expect(app.enabled("id:disabled")).toBe(false);
	await expect(app.press("id:disabled")).rejects.toThrow();
	expect(app.shows("text:Selections: 0")).toBe(true);
	await app.press("id:choose");
	expect(app.shows("text:Selections: 1")).toBe(true);
	expect(app.shows("text:New session")).toBe(false);
	await app.press("id:trigger");
	await app.keyboard.press("escape");
	expect(app.shows("text:New session")).toBe(false);
});

test("Menu check state is caller-owned and nested selections close the menu", async () => {
	const app = await open("./ui-menu-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	await app.press("id:trigger");
	expect(app.shows("text:Checked: true")).toBe(true);
	expect(app.viewStyle("id:indicator")?.effectiveOpacity).toBe(1);
	await app.press("id:checked");
	await app.press("id:trigger");
	expect(app.shows("text:Checked: false")).toBe(true);
	expect(app.viewStyle("id:indicator")?.effectiveOpacity).toBe(0);
	await app.hover("text:More");
	expect(app.spanStyle("text:More").color).toBe(
		app.spanStyle("text:Hover reference").color,
	);
	await app.press("text:More");
	await app.press("id:nested");
	expect(app.shows("text:Selections: 1")).toBe(true);
	expect(app.shows("text:New session")).toBe(false);
});
