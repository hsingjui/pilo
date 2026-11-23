import { open, test } from "nsh/test";

test("Pilo saves, validates and publishes next-prompt settings changes", async () => {
	const app = await open("./save-next-prompt-settings-fixture.tsx");
	await app.waitFor("text:next-prompt settings saves verified", {
		timeout: 15000,
	});
});
