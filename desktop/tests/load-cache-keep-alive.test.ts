import { open, test } from "nsh/test";

test("Pilo loads the saved cache keep-alive policies for a connection", async () => {
	const app = await open("./load-cache-keep-alive-fixture.tsx");
	await app.waitFor("text:cache keep-alive policies loaded", {
		timeout: 15000,
	});
});
