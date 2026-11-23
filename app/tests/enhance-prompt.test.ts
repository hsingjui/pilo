import { open, test } from "nsh/test";

test("Pilo rewrites a draft using the configured or chat model and reports failures", async () => {
	const app = await open("./enhance-prompt-fixture.tsx");
	try {
		await app.waitFor("text:prompt enhancement verified", { timeout: 15000 });
	} catch (error) {
		throw new Error(`${String(error)}; fixture: ${app.texts().join(" ")}`);
	}
});
