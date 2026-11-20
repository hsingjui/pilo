import { expect, open, test } from "nsh/test";

async function openApp() {
	const app = await open("./settings-dialog-fixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 720,
		locale: "en-US",
	});
	await app.waitFor("id:sidebar-settings");
	return app;
}

test("the sidebar gear opens the settings dialog", async () => {
	const app = await openApp();
	await app.press("id:sidebar-settings");
	await app.waitFor("id:settings-dialog");
	expect(app.shows("id:settings-nav-preferences")).toBe(true);
	expect(app.shows("id:settings-nav-about")).toBe(true);
	expect(app.shows("id:settings-send-shortcut")).toBe(true);
});

test("mod+, opens the settings dialog", async () => {
	const app = await openApp();
	await app.keyboard.press("mod+,");
	await app.waitFor("id:settings-dialog");
});

test("the close button dismisses the dialog", async () => {
	const app = await openApp();
	await app.press("id:sidebar-settings");
	await app.waitFor("id:settings-dialog");
	await app.press("id:settings-dialog-close");
	await app.waitFor("id:settings-dialog", { state: "gone" });
});

test("under md the nav collapses into a select in the header", async () => {
	const app = await openApp();
	await app.press("id:sidebar-settings");
	await app.waitFor("id:settings-dialog");
	expect(app.shows("id:settings-nav")).toBe(true);
	await app.setViewport(700, 720);
	await app.waitFor("id:settings-nav", { state: "gone" });
	await app.waitFor("id:settings-tab-select");
	await app.press("id:settings-tab-select");
	await app.press("text:About");
	await app.waitFor("id:settings-repository");
	await app.setViewport(1100, 720);
	await app.waitFor("id:settings-nav");
	await app.waitFor("id:settings-tab-select", { state: "gone" });
});

test("a preferences switch saves through the client", async () => {
	const app = await openApp();
	await app.press("id:sidebar-settings");
	await app.waitFor("id:settings-dialog");
	await app.press("id:settings-collapse-long");
	await app.waitFor("text:true");
	expect(app.shows("id:settings-collapse-long")).toBe(true);
});

test("the nav moves between panes", async () => {
	const app = await openApp();
	await app.press("id:sidebar-settings");
	await app.waitFor("id:settings-dialog");
	await app.press("id:settings-nav-notifications");
	await app.waitFor("id:settings-desktop-notifications");
	await app.press("id:settings-nav-shortcuts");
	expect(app.shows("text:New session")).toBe(true);
	expect(app.shows("text:Composer")).toBe(true);
	expect(app.shows("text:New line")).toBe(true);
	await app.press("id:settings-nav-appearance");
	await app.waitFor("id:settings-theme-mode");
	expect(app.shows("id:settings-theme-tokens")).toBe(true);
	await app.press("id:settings-nav-fonts");
	await app.waitFor("id:settings-code-font");
	expect(app.shows("id:settings-fonts-reset-sizes")).toBe(true);
	await app.press("id:settings-nav-model-catalog");
	await app.waitFor("id:settings-catalog-model-pilo-claude-sonnet-4");
	await app.press("id:settings-nav-next-prompt");
	await app.waitFor("id:settings-next-prompt-local");
	await app.press("id:settings-nav-prompt-enhancement");
	await app.waitFor("id:settings-prompt-enhancement-local");
	await app.press("id:settings-nav-cache-keep-alive");
	await app.waitFor("id:settings-keep-alive-local-claude-sonnet-4");
	await app.press("id:settings-nav-session-naming");
	await app.waitFor("id:settings-naming-model-local");
	await app.press("id:settings-nav-connections");
	await app.waitFor("id:settings-conn-test-ssh:prod");
	expect(app.shows("id:settings-conn-test-local")).toBe(true);
	expect(app.shows("id:settings-ssh-add")).toBe(true);
	await app.press("id:settings-nav-desktop");
	await app.waitFor("id:settings-launch-at-login");
	await app.press("id:settings-nav-about");
	await app.waitFor("id:settings-repository");
	expect(app.shows("id:settings-send-shortcut")).toBe(false);
});
