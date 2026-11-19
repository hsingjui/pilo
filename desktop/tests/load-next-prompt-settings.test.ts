import { open, test } from "nsh/test";

test("Pilo loads default and saved next-prompt settings", async () => {
	const app = await open("./load-next-prompt-settings-fixture.tsx");
	await app.waitFor("text:next-prompt settings loaded", { timeout: 15000 });
});
