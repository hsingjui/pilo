import { open, test } from "nsh/test";

test("Pilo searches saved messages and deletes a reconciled session", async () => {
	const app = await open("./session-actions-fixture.tsx");
	await app.waitFor("text:session search and deletion verified", {
		timeout: 15000,
	});
});

test("Pilo generates a normalized session title with the configured naming model", async () => {
	const app = await open("./session-actions-fixture.tsx", {
		host: { params: { naming: true } },
	});
	await app.waitFor("text:session title generation verified", {
		timeout: 15000,
	});
});
