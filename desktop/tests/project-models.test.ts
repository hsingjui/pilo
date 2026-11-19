import { open, test } from "nsh/test";

test("Pilo reads saved project models, commands and defaults without probing Pi", async () => {
	const app = await open("./project-models-fixture.tsx");
	await app.waitFor("text:saved project models verified", { timeout: 15000 });
});
