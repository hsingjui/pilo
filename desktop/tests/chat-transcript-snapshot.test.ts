import { open, test } from "nsh/test";

test("Pilo captures idle, active and truncated transcripts", async () => {
	const app = await open("./chat-transcript-snapshot-fixture.tsx");
	try {
		await app.waitFor(
			"text:idle, active and truncated transcript snapshots verified",
			{ timeout: 15000 },
		);
	} catch (error) {
		throw new Error(`${String(error)}; fixture: ${app.texts().join(" ")}`);
	}
});
