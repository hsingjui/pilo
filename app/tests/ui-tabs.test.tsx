import { expect, open, test } from "nsh/test";

test("Tabs report presses, follow caller selection and leave panels to the caller", async () => {
	const app = await open("./ui-tabs-fixture.tsx", { platform: "macos" });
	expect(app.shows("text:Overview panel")).toBe(true);
	expect(app.shows("text:History panel")).toBe(false);
	const overviewColor = app.spanStyle("text:overview").color;
	const historyColor = app.spanStyle("text:history").color;
	expect(overviewColor).not.toBe(historyColor);
	await app.press("id:history");
	await app.waitFor("text:History panel");
	await app.waitFor("text:Overview panel", { state: "gone" });
	await app.waitUntil(
		() => app.spanStyle("text:history").color === overviewColor,
	);
	expect(app.spanStyle("text:overview").color).not.toBe(overviewColor);
	await app.waitFor("text:Presses: 1");
	await app.press("id:overview");
	await app.waitFor("text:Overview panel");
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
	const color = app.spanStyle("text:Fixed selected").color;
	await app.press("id:fixed-other");
	await app.waitFor("text:Presses: 1");
	expect(app.spanStyle("text:Fixed selected").color).toBe(color);
	expect(app.spanStyle("text:Fixed other").color).not.toBe(color);
});
