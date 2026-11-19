import { expect, open, test, type App } from "nsh/test";

const options = {
	platform: "macos" as const,
	width: 1280,
	height: 800,
	clock: {},
};

function offset(app: App, axis: "Vertical" | "Horizontal") {
	return Number(
		app
			.texts()
			.find((text) => text.startsWith(`${axis} offset: `))
			?.split(": ")[1],
	);
}

// nsh/test omits native animated opacity and exposes no thumb ref; pointer helpers
// bypass overlapping native responders. Verify visibility/geometry with native screenshots.

test("Scrollbar follows scrolling and dragging its centered thumb scrolls both axes", async () => {
	const app = await open("./ui-scrollbar-fixture.tsx", options);
	await app.scroll("id:vertical", 120);
	expect(offset(app, "Vertical")).toBeGreaterThan(0);
	await app.scroll("id:horizontal", 120);
	expect(offset(app, "Horizontal")).toBeGreaterThan(0);
	await app.press("id:center");
	expect(offset(app, "Vertical")).toBe(480);
	expect(offset(app, "Horizontal")).toBe(480);
	await app.drag("id:vertical-bar", { y: 35 });
	expect(offset(app, "Vertical")).toBeGreaterThan(580);
	await app.drag("id:horizontal-bar", { x: 35 });
	expect(offset(app, "Horizontal")).toBeGreaterThan(580);
});

test("Scrollbar shared thumb look resolves resting and hover token colors in both themes", async () => {
	const app = await open("./ui-scrollbar-fixture.tsx", options);
	const lody = app.viewStyle("id:reference")?.backgroundColor;
	for (const theme of ["Lody", "Claude"]) {
		if (theme === "Claude") await app.press("id:claude");
		if (theme === "Claude")
			expect(app.viewStyle("id:reference")?.backgroundColor).not.toBe(lody);
		expect(app.viewStyle("id:thumb-color")?.backgroundColor).toBe(
			app.viewStyle("id:reference")?.backgroundColor,
		);
		await app.hover("id:thumb-color");
		await app.wait(200);
		expect(app.viewStyle("id:thumb-color")?.backgroundColor).toBe(
			app.viewStyle("id:hover-reference")?.backgroundColor,
		);
		await app.hover("id:claude");
		await app.wait(200);
	}
});
