import { expect, open, test } from "nsh/test";

test("FontSizeInput commits a typed size on Enter, clamped to the range", async () => {
	const app = await open("./settings-font-size-input-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	expect(app.shows("text:Value: 15; saved: none")).toBe(true);
	// Typing edits a draft only; an out-of-range value clamps on commit.
	await app.clear("id:size");
	await app.type("id:size", "99");
	expect(app.shows("text:Value: 15; saved: none")).toBe(true);
	await app.submit("id:size");
	await app.waitFor("text:Value: 18; saved: 18");
});

test("FontSizeInput reverts on Escape and on an empty field", async () => {
	const app = await open("./settings-font-size-input-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	// Escape drops the draft without saving.
	await app.type("id:size", "3");
	await app.keyboard.press("escape");
	expect(app.shows("text:Value: 15; saved: none")).toBe(true);
	// Clearing the field and leaving it reverts instead of saving.
	await app.clear("id:size");
	await app.press("id:elsewhere");
	await app.waitFor("text:Value: 15; saved: none");
	// A fresh edit still commits: clear the field, then type 13.
	await app.clear("id:size");
	await app.type("id:size", "13");
	await app.submit("id:size");
	await app.waitFor("text:Value: 13; saved: 13");
});
