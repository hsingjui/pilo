import { expect, open, test } from "nsh/test";

test("Lody background follows the app appearance", async () => {
	const app = await open("../App.tsx", { colorScheme: "light" });
	expect(app.viewStyle("id:app")?.backgroundColor).toBe("#ffffffff");
	await app.setColorScheme("dark");
	expect(app.viewStyle("id:app")?.backgroundColor).toBe("#101010ff");
});
