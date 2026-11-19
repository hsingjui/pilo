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

test("Popover preserves native center alignment and supports explicit start alignment", async () => {
	const app = await open("./ui-popover-fixture.tsx", {
		platform: "macos",
		width: 1000,
		height: 800,
	});
	await app.press("id:position-trigger");
	await app.waitFor("text:Left delta: -64; Center delta: 0");
	await app.keyboard.press("escape");
	await app.press("id:position-start");
	await app.waitFor("text:Left delta: 0; Center delta: 64");
});
