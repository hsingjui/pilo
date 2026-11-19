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

test("Pilo loads a seeded chat's history before starting that session", async () => {
	const app = await open("./chat-transcript-snapshot-fixture.tsx", {
		host: { params: { loadHistoryFirst: true } },
	});
	try {
		await app.waitFor("text:seeded session history loaded and chat started", {
			timeout: 15000,
		});
	} catch (error) {
		throw new Error(`${String(error)}; fixture: ${app.texts().join(" ")}`);
	}
});
