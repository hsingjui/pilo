import { expect, open, test } from "nsh/test";

test("Dialog opens and closes through actions, Escape and the backdrop, including alertdialog", async () => {
	const app = await open("./ui-dialog-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	expect(app.shows("text:Edit session")).toBe(false);
	await app.press("id:open");
	expect(app.shows("text:Edit session")).toBe(true);
	await app.waitUntil(() => !app.shows("text:Center: pending"));
	const center = Number(
		app
			.texts()
			.find((text) => text.startsWith("Center: "))
			?.slice(8),
	);
	expect(center).toBeGreaterThanOrEqual(299);
	expect(center).toBeLessThanOrEqual(301);
	await app.press("id:close");
	expect(app.shows("text:Edit session")).toBe(false);
	await app.press("id:open");
	await app.keyboard.press("escape");
	expect(app.shows("text:Edit session")).toBe(false);
	await app.press("id:alert");
	expect(app.shows("text:Confirm action")).toBe(true);
	await app.press("id:backdrop");
	expect(app.shows("text:Confirm action")).toBe(false);
});

test("Dialog keyboard focus cycles inside the modal", async () => {
	const app = await open("./ui-dialog-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	await app.press("id:open");
	await app.type("id:first", "A title");
	expect(app.shows("text:Focus: first")).toBe(true);
	await app.keyboard.press("tab");
	expect(app.shows("text:Focus: second")).toBe(true);
	for (let i = 0; i < 5; i++) {
		await app.keyboard.press("tab");
		expect(app.shows("text:Focus: outside")).toBe(false);
	}
	expect(app.shows("text:Focus: first")).toBe(true);
});
