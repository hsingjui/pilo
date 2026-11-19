import { open, test } from "nsh/test";

test("Pilo requests next-prompt assistance from an existing ready chat", async () => {
	const app = await open("./request-next-prompt-fixture.tsx");
	try {
		await app.waitFor("text:next-prompt request and cancellation reached Pi", {
			timeout: 15000,
		});
	} catch (error) {
		throw new Error(`${String(error)}; fixture: ${app.texts().join(" ")}`);
	}
});
