import { open, test } from "nsh/test";

test("Pilo reads real project and JSONL image bytes through the runtime", async () => {
	const app = await open("./image-readers-fixture.tsx");
	await app.waitFor("text:project and transcript image bytes verified");
});
