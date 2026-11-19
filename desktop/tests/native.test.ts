import { expect, open, test } from "nsh/test";

test("the native shell exposes its crate version", async () => {
	const app = await open("./native-fixture.tsx");
	expect(app.texts()).toEqual(["0.1.0"]);
});
