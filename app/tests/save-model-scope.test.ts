import { open, test } from "nsh/test";

test("Pilo saves, validates and publishes project model scope updates", async () => {
	const app = await open("./save-model-scope-fixture.tsx");
	await app.waitFor("text:model scope updates verified", { timeout: 15000 });
});
