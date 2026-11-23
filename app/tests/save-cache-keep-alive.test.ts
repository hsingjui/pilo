import { open, test } from "nsh/test";

test("Pilo saves, validates and publishes cache keep-alive policy changes", async () => {
	const app = await open("./save-cache-keep-alive-fixture.tsx");
	await app.waitFor("text:cache keep-alive policy saves verified", {
		timeout: 15000,
	});
});
