import { expect, open, test } from "nsh/test";

test("Popover opens by trigger and closes on Escape and outside press", async () => {
	const app = await open("./ui-popover-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	expect(app.shows("text:Popover content")).toBe(false);
	await app.press("id:trigger");
	await app.waitFor("text:Popover content");
	await app.waitFor("text:Open: true");
	await app.keyboard.press("escape");
	await app.waitFor("text:Popover content", { state: "gone" });
	await app.press("id:trigger");
	await app.waitFor("text:Popover content");
	await app.press("id:outside");
	await app.waitFor("text:Popover content", { state: "gone" });
	await app.waitFor("text:Open: false");
});

test("Popover also owns uncontrolled state and toggles closed from its trigger", async () => {
	const app = await open("./ui-popover-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	await app.press("id:uncontrolled");
	await app.waitFor("text:Uncontrolled content");
	await app.press("id:uncontrolled");
	await app.waitFor("text:Uncontrolled content", { state: "gone" });
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
