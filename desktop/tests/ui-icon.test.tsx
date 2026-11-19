import { expect, open, test } from "nsh/test";
import { Icon, type IconName } from "../ui/icon";
import icons from "../app/lucide-icons.json";

test("Icon renders every generated entry, exposes optional labels and keeps its size", async () => {
	const app = await open("./ui-icon-fixture.tsx");
	for (const name of Object.keys(icons)) {
		expect(app.shows(`id:catalog-${name}`)).toBe(true);
	}
	expect(app.shows("label:Palette icon")).toBe(true);
	await app.press("Measure icons");
	await app.waitFor("text:16x16, 24x24, 32x32");
});

test("Icon rejects an unknown or empty name at an untyped boundary", () => {
	for (const name of ["", "NotALucideIcon"]) {
		expect(() => Icon({ name: name as IconName })).toThrow(RangeError);
	}
});
