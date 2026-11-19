import { expect, open, test } from "nsh/test";

test("Toast shows, respects duration, persists without a timeout and dismisses manually", async () => {
	const app = await open("./ui-toast-fixture.tsx", {
		platform: "macos",
		width: 1280,
		height: 900,
		clock: {},
	});
	expect(app.shows("id:toast-Timed")).toBe(false);
	await app.press("id:timed");
	expect(app.shows("id:toast-Timed")).toBe(true);
	await app.wait(800);
	expect(app.shows("id:toast-Timed")).toBe(true);
	await app.wait(250);
	expect(app.shows("id:toast-Timed")).toBe(false);
	await app.press("id:manual");
	await app.wait(1500);
	expect(app.shows("id:toast-Manual")).toBe(true);
	await app.hover("id:toast-Manual");
	await app.press("label:Dismiss Manual");
	expect(app.shows("id:toast-Manual")).toBe(false);
});

test("Toast close button supplies its resting and hover foreground to nested icons and text", async () => {
	const app = await open("./ui-toast-fixture.tsx", {
		platform: "macos",
		width: 1280,
		height: 900,
	});
	for (const theme of ["Lody", "Claude"]) {
		if (theme === "Claude") await app.press("id:claude");
		expect(app.viewStyle("id:color-close")?.backgroundColor).toBe(
			app.viewStyle("id:close-muted")?.backgroundColor,
		);
		expect(app.spanStyle("text:Close inherited text").color).toBe(
			app.spanStyle("text:Close resting reference").color,
		);
		await app.hover("id:close-preview");
		await app.waitUntil(
			() =>
				app.spanStyle("text:Close inherited text").color ===
				app.spanStyle("text:Close hover reference").color,
		);
		expect(app.viewStyle("id:color-close")?.backgroundColor).toBe(
			app.viewStyle("id:close-hover")?.backgroundColor,
		);
		expect(app.spanStyle("text:Close inherited text").color).toBe(
			app.spanStyle("text:Close hover reference").color,
		);
		await app.hover("id:claude");
		await app.waitUntil(
			() =>
				app.spanStyle("text:Close inherited text").color ===
				app.spanStyle("text:Close resting reference").color,
		);
		expect(app.viewStyle("id:color-close")?.backgroundColor).toBe(
			app.viewStyle("id:close-muted")?.backgroundColor,
		);
		expect(app.spanStyle("text:Close inherited text").color).toBe(
			app.spanStyle("text:Close resting reference").color,
		);
	}
});

test("ToastStack takes oldest-first children and Escape dismisses newest-first, including an empty stack", async () => {
	const app = await open("./ui-toast-fixture.tsx", {
		platform: "macos",
		width: 1280,
		height: 900,
		clock: {},
	});
	await app.press("id:stack");
	expect(app.texts().filter((text) => text.endsWith(" notification"))).toEqual([
		"First notification",
		"Second notification",
		"Third notification",
	]);
	await app.keyboard.press("escape");
	expect(app.shows("id:toast-Third")).toBe(false);
	expect(app.shows("id:toast-Second")).toBe(true);
	await app.keyboard.press("escape");
	await app.keyboard.press("escape");
	expect(app.shows("id:toast-First")).toBe(false);
	await app.keyboard.press("escape");
});

test("Toast duration pauses while its native stack is expanded", async () => {
	const app = await open("./ui-toast-fixture.tsx", {
		platform: "macos",
		width: 1280,
		height: 900,
		clock: {},
	});
	await app.press("id:timed");
	await app.hover("id:toast-Timed");
	expect(app.shows("text:Expanded: true")).toBe(true);
	await app.wait(1500);
	expect(app.shows("id:toast-Timed")).toBe(true);
	await app.hover("id:claude");
	expect(app.shows("text:Expanded: false")).toBe(true);
	await app.wait(1050);
	expect(app.shows("id:toast-Timed")).toBe(false);
});

test("Toast variants keep neutral surfaces and semantic icon colors in both themes", async () => {
	const app = await open("./ui-toast-fixture.tsx", {
		platform: "macos",
		width: 1280,
		height: 900,
	});
	for (const theme of ["Lody", "Claude"]) {
		if (theme === "Claude") await app.press("id:claude");
		for (const variant of ["default", "success", "info", "warning", "error"]) {
			expect(app.viewStyle(`id:variant-${variant}`)?.backgroundColor).toBe(
				app.viewStyle("id:surface")?.backgroundColor,
			);
			expect(app.viewStyle(`id:color-${variant}`)?.backgroundColor).toBe(
				app.viewStyle(`id:reference-${variant}`)?.backgroundColor,
			);
		}
	}
});
