import { expect, open, test } from "nsh/test";

test("Spinner matches Lucide geometry, supports class and explicit size, labels and late mounts", async () => {
	const app = await open("./ui-spinner-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	expect(app.shows("label:Loading")).toBe(true);
	await app.press("id:measure");
	await app.waitFor("text:24x24, 14x14, 32x32");
	await app.press("id:extra");
	await app.press("id:extra");
	await app.press("id:claude");
	expect(app.shows("label:Loading")).toBe(true);
});

test("Spinner fixture blocks JS for at least 1.5 seconds then resumes", async () => {
	const app = await open("./ui-spinner-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 760,
	});
	await app.press("id:block");
	await app.waitUntil(() =>
		app.texts().some((text) => text.startsWith("JS resumed after ")),
	);
	const result = app
		.texts()
		.find((text) => text.startsWith("JS resumed after "))!;
	expect(
		Number.parseInt(result.slice("JS resumed after ".length), 10) >= 1500,
	).toBe(true);
});
