import { open, test } from "nsh/test";

test("Pilo reads the current Pi catalog for a connection", async () => {
	const app = await open("./connection-models-fixture.tsx");
	await app.waitFor("text:connection models verified", { timeout: 15000 });
});
