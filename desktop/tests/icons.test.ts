import { expect, open, test } from "nsh/test";

test("generated Lucide data draws as Canvas paths", async () => {
	const app = await open("./icons-fixture.tsx");
	await app.press("Check icons");
	expect(app.shows("text:Icon geometry ready")).toBe(true);
});
