import { expect, open, test } from "nsh/test";

test("Select shows its placeholder, ignores disabled items, and reports a controlled choice", async () => {
	const app = await open("./ui-select-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 650,
	});
	await app.press("text:Choose a model");
	await app.waitFor("text:Unavailable");
	expect(app.enabled("text:Unavailable")).toBe(false);
	await expect(app.press("text:Unavailable")).rejects.toThrow();
	expect(app.shows("text:Value: none; changes: 0")).toBe(true);
	await app.press("text:Quality");
	await app.waitFor("text:Value: quality; changes: 1");
	await app.waitFor("text:Choose a model", { state: "gone" });
	await app.waitFor("text:Unavailable", { state: "gone" });
	expect(app.count("text:Quality")).toBe(1);
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
	await app.waitFor("text:Quality");
	await app.press("text:Quality");
	await app.waitFor("text:Fast", { state: "gone" });
	await app.waitFor("text:Quality");
	await app.press("text:Empty select");
	await app.waitFor("text:No options");
	await app.keyboard.press("escape");
	await app.waitFor("text:No options", { state: "gone" });
});
