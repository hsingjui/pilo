import { open, test } from "nsh/test";

test("Pilo reads settled history and windows and rejects a missing session", async () => {
	const app = await open("./load-history-fixture.tsx");
	try {
		await app.waitFor(
			"text:settled history, window and missing session verified",
			{ timeout: 15000 },
		);
	} catch (error) {
		throw new Error(`${String(error)}; fixture: ${app.texts().join(" ")}`);
	}
});
