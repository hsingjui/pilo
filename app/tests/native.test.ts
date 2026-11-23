import { expect, open, test } from "nsh/test";

import manifest from "../../nsh.json";

test("the native shell exposes its crate version", async () => {
	const app = await open("./native-fixture.tsx");
	expect(app.texts()).toEqual([manifest.version]);
});
