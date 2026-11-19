import { open, test } from "nsh/test";

test("Pilo saves, validates and publishes prompt enhancement settings changes", async () => {
	const app = await open("./save-prompt-enhancement-settings-fixture.tsx");
	try {
		await app.waitFor("text:prompt enhancement settings saves verified", {
			timeout: 15000,
		});
	} catch (error) {
		throw new Error(`${String(error)}; fixture: ${app.texts().join(" ")}`);
	}
});
