import { open, test } from "nsh/test";

test("Pilo polls ordered runtime event batches and wakes on shutdown", async () => {
	const app = await open("./runtime-events-fixture.tsx");
	await app.waitFor(
		"text:ordered runtime batches and shutdown closure verified",
	);
});
