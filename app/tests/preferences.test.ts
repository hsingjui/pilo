import { open, test } from "nsh/test";

test("Pilo patches, validates, and persists Host preferences", async () => {
	const app = await open("./preferences-fixture.tsx");
	await app.waitFor("text:preferences patched, validated, and persisted");
});
