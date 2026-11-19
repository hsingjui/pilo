import { open, test } from "nsh/test";

test("Pilo saves a keep-alive policy without interrupting a running chat", async () => {
	const app = await open("./save-cache-keep-alive-running-fixture.tsx");
	try {
		await app.waitFor("text:cache keep-alive saved while chat stayed running", {
			timeout: 15000,
		});
	} catch (error) {
		throw new Error(`${String(error)}; fixture: ${app.texts().join(" ")}`);
	}
});
