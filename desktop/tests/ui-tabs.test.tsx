import { expect, open, test } from "nsh/test";

test("Tabs report presses, follow caller selection and leave panels to the caller", async () => {
	const app = await open("./ui-tabs-fixture.tsx", { platform: "macos" });
	expect(app.shows("text:Overview panel")).toBe(true);
	expect(app.shows("text:History panel")).toBe(false);
	const selectedColor = app.viewStyle("id:reference-selected")?.backgroundColor;
	expect(app.viewStyle("id:overview")?.backgroundColor).toBe(selectedColor);
	await app.press("id:history");
	expect(app.shows("text:History panel")).toBe(true);
	expect(app.shows("text:Overview panel")).toBe(false);
	expect(app.viewStyle("id:history")?.backgroundColor).toBe(selectedColor);
	expect(app.viewStyle("id:overview")?.backgroundColor).not.toBe(selectedColor);
	expect(app.shows("text:Presses: 1")).toBe(true);
	await app.press("id:overview");
	expect(app.shows("text:Overview panel")).toBe(true);
});

test("Tabs permit an empty list, ignore disabled tabs and do not own selection", async () => {
	const app = await open("./ui-tabs-fixture.tsx", { platform: "macos" });
	expect(app.shows("id:empty")).toBe(true);
	expect(app.enabled("id:disabled")).toBe(false);
	await expect(app.press("id:disabled")).rejects.toMatchObject({
		code: "ERR_NSH_TEST_DISABLED",
	});
	expect(app.shows("text:Presses: 0")).toBe(true);
	expect(app.shows("text:Overview panel")).toBe(true);
	const color = app.viewStyle("id:fixed-selected")?.backgroundColor;
	await app.press("id:fixed-other");
	expect(app.shows("text:Presses: 1")).toBe(true);
	expect(app.viewStyle("id:fixed-selected")?.backgroundColor).toBe(color);
	expect(app.viewStyle("id:fixed-other")?.backgroundColor).not.toBe(color);
});
