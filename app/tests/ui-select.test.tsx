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

test("Select caps long lists to a bounded height and scrolls to the last option", async () => {
	const app = await open("./ui-select-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 750,
	});
	await app.press("id:long-select");
	await app.waitFor("text:Option 1");
	// With 24 items capped at 288pt, the last option starts scrolled out of view.
	expect(app.shows("text:Option 24")).toBe(false);
	await app.scroll("text:Option 1", 2000);
	await app.waitFor("text:Option 24");
	await app.press("text:Option 24");
	await app.waitFor("text:Long: option-24");
});

test("Searchable Select filters options without overflowing short lists", async () => {
	const app = await open("./ui-select-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 750,
	});
	await app.press("id:searchable-select");
	await app.waitFor("label:Filter options");
	await app.type("label:Filter options", "qual");
	await app.waitFor("text:Unavailable", { state: "gone" });
	await app.press("text:Quality");
	await app.waitFor("text:Searchable: quality");
});
