import { expect, open, test } from "nsh/test";

test("FontSelect groups options, previews them and reports a choice", async () => {
	const app = await open("./settings-font-select-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 650,
	});
	// The trigger shows the chosen option's resolved label, not its value.
	expect(app.shows("text:System default")).toBe(true);
	expect(app.shows("text:system-sans")).toBe(false);
	expect(app.shows("text:System monospace")).toBe(true);
	await app.press("id:font-select");
	await app.waitFor("text:SF Pro");
	// Both group headers are shown.
	expect(app.shows("text:Built-in")).toBe(true);
	expect(app.shows("text:System fonts")).toBe(true);
	await app.press("text:Helvetica");
	await app.waitFor("text:Value: helvetica");
	expect(app.shows("text:Helvetica")).toBe(true);
});

test("FontSelect searches and offers the typed name as a custom family", async () => {
	const app = await open("./settings-font-select-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 650,
	});
	await app.press("id:font-select");
	await app.waitFor("text:SF Pro");
	await app.type("label:Search fonts…", "helv");
	await app.waitFor("text:SF Pro", { state: "gone" });
	expect(app.shows("text:Helvetica")).toBe(true);
	// A query that names no option becomes a custom family choice.
	await app.clear("label:Search fonts…");
	await app.type("label:Search fonts…", "My Custom Font");
	await app.waitFor("text:Helvetica", { state: "gone" });
	expect(app.shows('text:Use "My Custom Font"')).toBe(true);
	await app.press('text:Use "My Custom Font"');
	await app.waitFor("text:Value: My Custom Font");
	// A custom value is no listed option, so the trigger shows it as typed.
	expect(app.shows("text:My Custom Font")).toBe(true);
});
