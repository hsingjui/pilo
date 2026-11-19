import { expect, open, test } from "nsh/test";

test("Gallery Popover and Menu panels align to their triggers in both themes", async () => {
	const app = await open("./ui-gallery-fixture.tsx", {
		platform: "macos",
		width: 1280,
		height: 1100,
	});
	for (const theme of ["Lody", "Claude"]) {
		if (theme === "Claude") await app.press("id:claude");
		await app.press("id:show-floating");
		await app.press("id:measure-floating");
		expect(app.shows("text:Popover: 32.0 / 32.0; Menu: 352.0 / 352.0")).toBe(
			true,
		);
	}
});
