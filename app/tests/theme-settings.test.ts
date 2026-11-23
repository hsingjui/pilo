import { open, test } from "nsh/test";

test("Pilo loads and saves Host theme settings without losing legacy CSS", async () => {
	const app = await open("./theme-settings-fixture.tsx");
	await app.waitFor(
		"text:Host theme settings converted, validated, and persisted",
	);
});
