import { expect, open, test } from "nsh/test";

async function openPane(platform: "macos" | "windows" = "macos") {
	const app = await open("./about-pane-fixture.tsx", {
		platform,
		width: 900,
		height: 700,
		locale: "en-US",
	});
	await app.waitFor("id:settings-update-check");
	return app;
}

test("the header, version, repository and log rows render", async () => {
	const app = await openPane();
	expect(app.shows("id:about-app-icon")).toBe(true);
	expect(app.shows("text:Pilo")).toBe(true);
	expect(app.shows("text:A lightweight Pi desktop client.")).toBe(true);
	expect(app.shows("text:Version")).toBe(true);
	expect(app.enabled("id:settings-repository")).toBe(true);
	expect(app.shows("text:GitHub")).toBe(true);
	expect(app.enabled("id:settings-open-log-directory")).toBe(true);
});

test("the update check settles on up to date without a source", async () => {
	const app = await openPane();
	expect(app.shows("text:Release notes")).toBe(true);
	expect(app.enabled("id:settings-release-notes")).toBe(true);
	await app.press("id:settings-update-check");
	await app.waitFor("text:Up to date");
});
