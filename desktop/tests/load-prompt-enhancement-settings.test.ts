import { open, test } from "nsh/test";

test("Pilo loads default and saved prompt enhancement settings", async () => {
	const app = await open("./load-prompt-enhancement-settings-fixture.tsx");
	try {
		await app.waitFor("text:prompt enhancement settings loaded", {
			timeout: 15000,
		});
	} catch (error) {
		throw new Error(`${String(error)}; fixture: ${app.texts().join(" ")}`);
	}
});
