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
	expect(app.shows("id:settings-theme-token-search")).toBe(false);
	await app.press("id:settings-nav-fonts");
	await app.waitFor("id:settings-code-font");
	await app.press("id:settings-fonts-reset");
	await app.waitFor("id:settings-fonts-reset-sizes");
	expect(app.shows("id:settings-fonts-reset-families")).toBe(true);
	await app.keyboard.press("escape");
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
	expect(app.shows("id:settings-conn-add")).toBe(true);
	await app.press("id:settings-nav-preferences");
	await app.waitFor("text:Launch at login");
	await app.press("id:settings-nav-about");
	await app.waitFor("id:settings-repository");
	expect(app.shows("id:settings-send-shortcut")).toBe(false);
});

test("the model settings panes cover every configured connection", async () => {
	const app = await openApp();
	await app.press("id:sidebar-settings");
	await app.waitFor("id:settings-dialog");
	await app.press("id:settings-nav-next-prompt");
	await app.waitFor("id:settings-next-prompt-ssh:prod");
	expect(app.shows("id:settings-next-prompt-wsl:Ubuntu")).toBe(true);
	expect(app.shows("id:settings-next-prompt-model-ssh:prod")).toBe(true);
	await app.press("id:settings-nav-prompt-enhancement");
	await app.waitFor("id:settings-prompt-enhancement-ssh:prod");
	expect(app.shows("id:settings-prompt-enhancement-wsl:Ubuntu")).toBe(true);
	await app.press("id:settings-nav-session-naming");
	await app.waitFor("id:settings-naming-model-ssh:prod");
	expect(app.shows("id:settings-naming-model-wsl:Ubuntu")).toBe(true);
	await app.press("id:settings-nav-cache-keep-alive");
	await app.waitFor("id:settings-keep-alive-add-ssh:prod");
	expect(app.shows("id:settings-keep-alive-add-wsl:Ubuntu")).toBe(true);
});

test("a next-prompt settings event updates the pane", async () => {
	const app = await openApp();
	await app.press("id:sidebar-settings");
	await app.waitFor("id:settings-dialog");
	await app.press("id:settings-nav-next-prompt");
	await app.waitFor("id:settings-next-prompt-local");
	await app.host.send("fixture", "emit-next-prompt");
	await app.waitFor("text:GPT-5 mini · openai");
});

test("the keep-alive picker adds a model", async () => {
	const app = await openApp();
	await app.press("id:sidebar-settings");
	await app.waitFor("id:settings-dialog");
	await app.press("id:settings-nav-cache-keep-alive");
	await app.waitFor("id:settings-keep-alive-add-local");
	await app.press("id:settings-keep-alive-add-local");
	await app.waitFor("text:GPT-5 mini · openai");
	await app.press("text:GPT-5 mini · openai");
	await app.waitFor("id:settings-keep-alive-local-gpt-5-mini");
});

test("a keep-alive settings event updates a row", async () => {
	const app = await openApp();
	await app.press("id:sidebar-settings");
	await app.waitFor("id:settings-dialog");
	await app.press("id:settings-nav-cache-keep-alive");
	await app.waitFor("id:settings-keep-alive-ttl-local-claude-sonnet-4");
	await app.host.send("fixture", "emit-keep-alive");
	await app.waitFor("id:settings-keep-alive-local-claude-sonnet-4");
	expect(app.value("id:settings-keep-alive-ttl-local-claude-sonnet-4")).toBe(
		"10",
	);
});

test("the shortcuts pane records, resets rows and resets all", async () => {
	const app = await openApp();
	await app.press("id:sidebar-settings");
	await app.waitFor("id:settings-dialog");
	await app.press("id:settings-nav-shortcuts");
	await app.waitFor("text:New session");
	// The fixture presets custom shortcuts on two rows; a box press swaps in
	// the recorder. Headless keys never reach inputs, so capture is covered
	// by pressing through to the resets instead.
	await app.press("id:shortcut-box-new-chat");
	await app.waitFor("id:shortcut-recorder");
	await app.press("id:shortcut-box-toggle-sidebar");
	await app.waitFor("id:shortcut-recorder");
	await app.press("label:Reset New session shortcut to default");
	await app.host.send("fixture", "probe-shortcuts");
	await app.waitUntil(() =>
		app.storage()["shortcut-patches"]?.includes('"new-chat":"mod+n"'),
	);
	await app.press("id:shortcuts-reset-all");
	await app.host.send("fixture", "probe-shortcuts");
	await app.waitUntil(() =>
		app.storage()["shortcut-patches"]?.includes('"toggle-sidebar":"mod+b"'),
	);
});

test("a keep-alive edit commits on blur and Escape cancels it", async () => {
	const app = await openApp();
	await app.press("id:sidebar-settings");
	await app.waitFor("id:settings-dialog");
	await app.press("id:settings-nav-cache-keep-alive");
	await app.waitFor("id:settings-keep-alive-ttl-local-claude-sonnet-4");
	const ttl = "id:settings-keep-alive-ttl-local-claude-sonnet-4";
	const duration = "id:settings-keep-alive-duration-local-claude-sonnet-4";
	await app.clear(ttl);
	await app.type(ttl, "12");
	// Moving focus commits the draft: the probe reads the saved row.
	await app.type(duration, "");
	await app.host.send("fixture", "probe-keep-alive");
	await app.waitUntil(
		() => app.storage()["keep-alive-probe"] === "claude-sonnet-4:true:720:1800",
	);
	await app.clear(duration);
	await app.type(duration, "40");
	await app.keyboard.press("escape");
	await app.type(ttl, "");
	await app.host.send("fixture", "probe-keep-alive");
	await app.waitUntil(
		() => app.storage()["keep-alive-probe"] === "claude-sonnet-4:true:720:1800",
	);
});
