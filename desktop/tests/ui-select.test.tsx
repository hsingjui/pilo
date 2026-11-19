import { expect, open, test } from "nsh/test";

test("Select shows its placeholder, ignores disabled items, and reports a controlled choice", async () => {
	const app = await open("./ui-select-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 650,
	});
	await app.press("text:Choose a model");
	expect(app.enabled("text:Unavailable")).toBe(false);
	await expect(app.press("text:Unavailable")).rejects.toThrow();
	expect(app.shows("text:Value: none; changes: 0")).toBe(true);
	await app.press("text:Quality");
	expect(app.shows("text:Value: quality; changes: 1")).toBe(true);
	expect(app.shows("text:Choose a model")).toBe(false);
	expect(app.count("text:Quality")).toBe(1);
	expect(app.shows("text:Unavailable")).toBe(false);
});

test("Select supports uncontrolled defaults, disabled triggers and empty items", async () => {
	const app = await open("./ui-select-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 650,
	});
	expect(app.enabled("text:Disabled select")).toBe(false);
	await expect(app.press("text:Disabled select")).rejects.toThrow();
	await app.press("text:Fast");
	await app.press("text:Quality");
	expect(app.shows("text:Quality")).toBe(true);
	expect(app.shows("text:Fast")).toBe(false);
	await app.press("text:Empty select");
	expect(app.shows("text:No options")).toBe(true);
	await app.keyboard.press("escape");
	expect(app.shows("text:No options")).toBe(false);
});
