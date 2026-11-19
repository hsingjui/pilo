import { open, test } from "nsh/test";

test("Pilo bootstraps the runtime and rejects reads after idempotent shutdown", async () => {
	const app = await open("./bootstrap-fixture.tsx");
	await app.waitFor(
		"text:workspace and chat snapshots loaded; Pilo runtime has been shut down",
	);
});
