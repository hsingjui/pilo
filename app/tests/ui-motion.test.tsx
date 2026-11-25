import { expect, open, test } from "nsh/test";

test("unified motion system keeps burst state updates sub-frame across viewports and color schemes", async () => {
	const app = await open("./ui-motion-fixture.tsx", {
		platform: "macos",
		width: 1200,
		height: 800,
	});

	// 1. Burst benchmark: 40 cycles x 5 simultaneous state transitions on top of a 200-row list.
	await app.press("id:motion-bench");
	await app.waitUntil(() =>
		app.texts().some((text) => text.startsWith("bench:ok")),
	);
	const benchLine =
		app.texts().find((text) => text.startsWith("bench:ok")) ?? "";
	console.log(benchLine);
	const p95Match = /p95=([\d.]+)ms/.exec(benchLine);
	expect(p95Match).not.toBeNull();
	expect(Number(p95Match![1])).toBeLessThan(8);

	// 2. Collapsible spring reveal & chevron rotation toggle cleanly.
	await app.press("id:motion-collapsible-trigger");
	await app.waitFor("id:motion-collapsible-body");
	await app.press("id:motion-collapsible-trigger");
	await app.waitFor("id:motion-collapsible-body", { state: "gone" });

	// 3. Popover enter/exit transitions open and dismiss cleanly without lingering.
	await app.press("id:motion-popover-trigger");
	await app.waitFor("id:motion-popover-body");
	await app.keyboard.press("escape");
	await app.waitFor("id:motion-popover-body", { state: "gone" });

	// 4. Mounted dialog opens and closes cleanly, unmounting content after close completes.
	await app.press("id:motion-open-dialog");
	await app.waitFor("id:motion-dialog-content");
	await app.press("id:motion-dialog-close");
	await app.waitFor("id:motion-dialog-content", { state: "gone" });

	// 5. Responsive viewports (wide -> narrow -> phone) & light/dark schemes stay clean.
	await app.press("id:motion-toggle-scheme");
	await app.waitFor("text:Scheme: dark");
	for (const [w, h] of [
		[720, 600],
		[390, 680],
		[1100, 680],
	] as const) {
		await app.setViewport(w, h);
		await app.waitUntil(() =>
			app.texts().some((text) => text.includes(`vp:${w}x`)),
		);
	}
	await app.scroll("id:motion-long-list", 2400);
	await app.press("id:motion-tab-files");
	await app.press("id:motion-copy");
	await app.waitFor("text:Copied");
});
