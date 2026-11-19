import { expect, open, test } from "nsh/test";

test("Switch uses theme track colors and reports controlled changes in both directions", async () => {
	const app = await open("./ui-switch-fixture.tsx", { platform: "macos" });
	expect(app.viewStyle("id:switch")?.backgroundColor).toBe(
		app.viewStyle("id:reference-off")?.backgroundColor,
	);
	expect(app.shows("text:Checked: false; changes: 0")).toBe(true);
	await app.press("id:switch");
	expect(app.shows("text:Checked: true; changes: 1")).toBe(true);
	expect(app.viewStyle("id:switch")?.backgroundColor).toBe(
		app.viewStyle("id:reference-on")?.backgroundColor,
	);
	await app.press("id:switch");
	expect(app.shows("text:Checked: false; changes: 2")).toBe(true);
	expect(app.viewStyle("id:switch")?.backgroundColor).toBe(
		app.viewStyle("id:reference-off")?.backgroundColor,
	);
});

test("Switch ignores disabled presses in checked and unchecked states", async () => {
	const app = await open("./ui-switch-fixture.tsx", { platform: "macos" });
	for (const id of ["disabled", "disabled-checked"]) {
		expect(app.viewStyle(`id:${id}`)?.backgroundColor).toBe(
			app.viewStyle(id === "disabled" ? "id:reference-off" : "id:reference-on")
				?.backgroundColor,
		);
		expect(app.enabled(`id:${id}`)).toBe(false);
		expect(app.viewStyle(`id:${id}`)?.opacity).toBe(0.5);
		await expect(app.press(`id:${id}`)).rejects.toMatchObject({
			code: "ERR_NSH_TEST_DISABLED",
		});
	}
	expect(app.shows("text:Checked: false; changes: 0")).toBe(true);
});
