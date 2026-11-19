import { open, test } from "nsh/test";

test("Pilo loads, acknowledges, and persists session read states", async () => {
	const app = await open("./session-read-state-fixture.tsx");
	await app.waitFor(
		"text:session read states loaded, acknowledged, and persisted",
	);
});
