import { registerFont } from "nsh";
import { expect, open, test } from "nsh/test";

import inter400 from "../fonts/inter-latin-400-normal.woff2?url";
import inter500 from "../fonts/inter-latin-500-normal.woff2?url";
import inter600 from "../fonts/inter-latin-600-normal.woff2?url";
import inter700 from "../fonts/inter-latin-700-normal.woff2?url";
import mono400 from "../fonts/jetbrains-mono-latin-400-normal.woff2?url";
import mono500 from "../fonts/jetbrains-mono-latin-500-normal.woff2?url";
import mono700 from "../fonts/jetbrains-mono-latin-700-normal.woff2?url";

test("the bundled app fonts register under their theme family names", async () => {
	const app = await open("./app-shell-fixture.tsx");
	await app.waitFor("id:sidebar >> text:Pilo");
	for (const source of [inter400, inter500, inter600, inter700]) {
		expect((await registerFont(source)).family).toBe("Inter");
	}
	for (const source of [mono400, mono500, mono700]) {
		expect((await registerFont(source)).family).toBe("JetBrains Mono");
	}
});
