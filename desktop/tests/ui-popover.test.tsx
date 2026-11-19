import { expect, open, test } from "nsh/test";

test("Popover opens by trigger and closes on Escape and outside press", async () => {
	const app = await open("./ui-popover-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	expect(app.shows("text:Popover content")).toBe(false);
	await app.press("id:trigger");
	expect(app.shows("text:Popover content")).toBe(true);
	expect(app.shows("text:Open: true")).toBe(true);
	await app.keyboard.press("escape");
	expect(app.shows("text:Popover content")).toBe(false);
	await app.press("id:trigger");
	await app.press("id:outside");
	expect(app.shows("text:Popover content")).toBe(false);
	expect(app.shows("text:Open: false")).toBe(true);
});

test("Popover also owns uncontrolled state and toggles closed from its trigger", async () => {
	const app = await open("./ui-popover-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	await app.press("id:uncontrolled");
	expect(app.shows("text:Uncontrolled content")).toBe(true);
	await app.press("id:uncontrolled");
	expect(app.shows("text:Uncontrolled content")).toBe(false);
});
