import { open, test } from "nsh/test";

test("Pilo loads inherited and stored project model scopes", async () => {
	const app = await open("./load-model-scope-fixture.tsx");
	await app.waitFor("text:inherited and stored model scopes verified", {
		timeout: 15000,
	});
});
