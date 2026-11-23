import { expect, open, test } from "nsh/test";

test("Dialog opens and closes through actions, Escape and the backdrop, including alertdialog", async () => {
	const app = await open("./ui-dialog-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	expect(app.shows("text:Edit session")).toBe(false);
	await app.press("id:open");
	await app.waitFor("text:Edit session");
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
	await app.waitFor("text:Edit session", { state: "gone" });
	const geometry =
		app.texts().find((text) => text.startsWith("Geometry: ")) ?? "";
	expect(geometry).toContain('"x":169');
	expect(geometry).toContain('"width":462');
	expect(geometry).toContain('"gap":16');
	await app.press("id:open");
	await app.waitFor("text:Edit session");
	await app.keyboard.press("escape");
	await app.waitFor("text:Edit session", { state: "gone" });
	await app.press("id:alert");
	await app.waitFor("text:Confirm action");
	await app.press("id:backdrop");
	await app.waitFor("text:Confirm action", { state: "gone" });
});

test("Dialog keyboard focus cycles inside the modal", async () => {
	const app = await open("./ui-dialog-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	await app.press("id:open");
	await app.waitFor("id:first");
	await app.type("id:first", "A title");
	expect(app.shows("text:Focus: first")).toBe(true);
	await app.keyboard.press("tab");
	await app.waitFor("text:Focus: second");
	for (let i = 0; i < 5; i++) {
		await app.keyboard.press("tab");
		expect(app.shows("text:Focus: outside")).toBe(false);
	}
	await app.waitFor("text:Focus: first");
});

test("Dialog scrolls tall content within viewport margins and follows window resizing", async () => {
	const app = await open("./ui-dialog-tall-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	await app.press("id:open");
	await app.waitUntil(() => !app.shows("text:Start: pending"));
	const start = Number(
		app
			.texts()
			.find((text) => text.startsWith("Start: "))
			?.slice(7),
	);
	expect(start).toBeGreaterThanOrEqual(16);
	for (const height of [600, 400]) {
		if (height === 400) await app.setViewport(800, height);
		await app.scroll("id:tall-dialog", 3000);
		await app.press("id:measure-end");
		const end = Number(
			app
				.texts()
				.find((text) => text.startsWith("End: "))
				?.slice(5),
		);
		expect(end).toBeLessThanOrEqual(height - 16);
		expect(end).toBeGreaterThan(100);
	}
});
