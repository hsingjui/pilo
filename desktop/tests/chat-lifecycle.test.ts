import { open, test } from "nsh/test";

test("Pilo starts a Pi chat and returns its ready process snapshot", async () => {
	const app = await open("./chat-lifecycle-fixture.tsx");
	await app.waitFor("text:startChat verified", { timeout: 15000 });
});

test("Pilo stops a running chat and accepts a repeated stop", async () => {
	const app = await open("./chat-lifecycle-fixture.tsx", {
		host: { params: { stop: true } },
	});
	await app.waitFor("text:stopChat verified", { timeout: 15000 });
});
