import { open, test } from "nsh/test";

test("Pilo lists projects and their saved sessions", async () => {
	const app = await open("./project-sessions-fixture.tsx");
	await app.waitFor("text:project catalog and saved sessions loaded");
});
