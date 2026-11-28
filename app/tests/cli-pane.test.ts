import { expect, open, test } from "nsh/test";

test("the CLI page installs, warns about PATH shadowing and uninstalls", async () => {
	const app = await open("./cli-pane-fixture.tsx", {
		platform: "macos",
		width: 900,
		height: 700,
		locale: "en-US",
	});
	await app.waitFor("id:settings-cli-install");
	expect(app.shows("text:Not installed")).toBe(true);
	expect(app.shows("text:Unknown")).toBe(true);
	expect(app.shows("id:settings-cli-uninstall")).toBe(false);

	await app.press("id:settings-cli-install");
	await app.waitFor("id:settings-cli-uninstall");
	expect(app.shows("text:Installed")).toBe(true);
	expect(app.shows("text:0.5.2")).toBe(true);
	expect(app.shows("id:settings-cli-location")).toBe(true);
	expect(app.shows("text:Shadowed")).toBe(true);
	expect(
		app.shows(
			"text:Administrator authorization was canceled, so the CLI was installed in /Users/me/.local/bin.",
		),
	).toBe(true);

	await app.press("id:settings-cli-uninstall");
	await app.waitFor("id:settings-cli-install");
	expect(app.shows("text:Not installed")).toBe(true);

	await app.waitFor("id:settings-cli-skill-install");
	expect(app.shows("id:settings-cli-skill-location")).toBe(true);

	await app.press("id:settings-cli-skill-install");
	await app.waitFor("id:settings-cli-skill-update");
	expect(app.shows("text:Update available")).toBe(true);

	await app.press("id:settings-cli-skill-update");
	await app.waitFor("id:settings-cli-skill-uninstall");
	expect(app.shows("id:settings-cli-skill-update")).toBe(false);

	await app.press("id:settings-cli-skill-uninstall");
	await app.waitFor("id:settings-cli-skill-install");
	expect(app.shows("id:settings-cli-skill-uninstall")).toBe(false);
});
