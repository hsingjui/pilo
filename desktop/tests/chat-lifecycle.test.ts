import { open, test } from "nsh/test";

test("Pilo starts a Pi chat and returns its ready process snapshot", async () => {
	const app = await open("./chat-lifecycle-fixture.tsx");
	await app.waitFor("text:startChat verified", { timeout: 15000 });
});
