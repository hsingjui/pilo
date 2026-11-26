import { expect, open, test } from "nsh/test";

async function openPane(platform: "macos" | "windows" = "macos") {
	const app = await open("./connections-pane-fixture.tsx", {
		platform,
		width: 900,
		height: 900,
		locale: "en-US",
	});
	await app.waitFor("id:settings-conn-test-local");
	return app;
}

test("local, WSL and SSH rows render with their details", async () => {
	const app = await openPane();
	expect(app.shows("id:settings-conn-home-local")).toBe(true);
	expect(app.shows("id:settings-conn-test-local")).toBe(true);
	expect(app.shows("id:settings-conn-configure-local")).toBe(true);
	expect(app.shows("text:This machine")).toBe(true);
	expect(app.shows("id:settings-conn-test-wsl:Ubuntu")).toBe(true);
	expect(app.shows("id:settings-conn-remove-wsl:Ubuntu")).toBe(true);
	expect(app.shows("id:settings-conn-test-ssh:prod")).toBe(true);
	expect(app.shows("id:settings-conn-edit-ssh:prod")).toBe(true);
	expect(app.shows("id:settings-conn-remove-ssh:prod")).toBe(true);
	expect(app.shows("text:deploy@prod.example.com:2222")).toBe(true);
	expect(app.shows("text:via ops@jump.example.com:22")).toBe(true);
	expect(app.shows("text:vault-alias")).toBe(true);
	expect(app.shows("id:settings-conn-add")).toBe(true);
});

test("testing a connection reports connection health", async () => {
	const app = await openPane();
	await app.press("id:settings-conn-test-local");
	await app.waitFor("text:Local is available");
	expect(app.shows("text:Connected (4 ms) · Pi not detected")).toBe(true);
});

test("the home toggle stays interactive", async () => {
	const app = await openPane();
	await app.press("id:settings-conn-home-ssh:prod");
	await app.wait(150);
	expect(app.enabled("id:settings-conn-home-ssh:prod")).toBe(true);
	await app.press("id:settings-conn-home-ssh:prod");
	await app.wait(150);
	expect(app.enabled("id:settings-conn-home-ssh:prod")).toBe(true);
});

test("the add button opens the SSH editor directly on macOS and adds an SSH connection", async () => {
	const app = await openPane();
	await app.press("id:settings-conn-add");
	await app.waitFor("id:settings-ssh-name");
	expect(app.shows("text:Add SSH connection")).toBe(true);
	expect(app.enabled("id:settings-ssh-save")).toBe(false);
	await app.waitFor("id:settings-ssh-agent-status");
	await app.type("id:settings-ssh-name", "staging");
	// Typing into a new SSH connection keeps the "Add SSH connection" title.
	expect(app.shows("text:Add SSH connection")).toBe(true);
	await app.type("id:settings-ssh-host", "staging.example.com");
	expect(app.enabled("id:settings-ssh-save")).toBe(true);
	await app.press("id:settings-ssh-save");
	await app.waitFor("text:staging");
});

test("a password SSH connection requires the password", async () => {
	const app = await openPane();
	await app.press("id:settings-conn-add");
	await app.waitFor("id:settings-ssh-name");
	await app.type("id:settings-ssh-name", "pw-host");
	await app.type("id:settings-ssh-host", "pw.example.com");
	await app.press("id:settings-ssh-auth");
	await app.press("text:Password");
	await app.waitFor("id:settings-ssh-password");
	await app.press("id:settings-ssh-save");
	await app.waitFor("text:Enter the SSH password.");
});

test("the SSH editor updates controlled mode, Pi runtime and local resources toggles in both directions", async () => {
	const app = await openPane();
	await app.press("id:settings-conn-add");
	await app.waitFor("id:settings-ssh-mode");

	// Switching connection mode updates the trigger label and can switch back.
	expect(app.shows("text:Direct connection")).toBe(true);
	expect(app.shows("id:settings-ssh-user")).toBe(true);
	await app.press("id:settings-ssh-mode");
	await app.waitFor("text:~/.ssh/config Host");
	await app.press("text:~/.ssh/config Host");
	await app.waitFor("id:settings-ssh-user", { state: "gone" });
	expect(app.shows("text:~/.ssh/config Host")).toBe(true);
	expect(app.shows("text:Direct connection")).toBe(false);
	await app.press("id:settings-ssh-mode");
	await app.waitFor("text:Direct connection");
	await app.press("text:Direct connection");
	await app.waitFor("id:settings-ssh-user");
	expect(app.shows("text:Direct connection")).toBe(true);
	expect(app.shows("text:~/.ssh/config Host")).toBe(false);

	// Expanding advanced options and toggling Pi runtime updates both the trigger and fields.
	await app.press("id:settings-ssh-advanced-toggle");
	await app.waitFor("id:settings-ssh-runtime");
	expect(app.shows("text:Remote Pi (SSH host)")).toBe(true);
	expect(app.shows("id:settings-ssh-pi")).toBe(true);
	expect(app.shows("id:settings-ssh-local-resources")).toBe(false);

	await app.press("id:settings-ssh-runtime");
	await app.waitFor("text:Local Pi (tools use SSH)");
	await app.press("text:Local Pi (tools use SSH)");
	await app.waitFor("id:settings-ssh-local-resources");
	expect(app.shows("id:settings-ssh-pi")).toBe(false);
	expect(app.shows("text:Local Pi (tools use SSH)")).toBe(true);
	expect(app.shows("text:Remote Pi (SSH host)")).toBe(false);

	// Toggling local Pi resources updates the switch track state in both directions.
	const offBg = app.viewStyle(
		"id:settings-ssh-local-resources",
	)?.backgroundColor;
	await app.press("id:settings-ssh-local-resources");
	await app.waitUntil(
		() =>
			app.viewStyle("id:settings-ssh-local-resources")?.backgroundColor !==
			offBg,
	);
	await app.press("id:settings-ssh-local-resources");
	await app.waitUntil(
		() =>
			app.viewStyle("id:settings-ssh-local-resources")?.backgroundColor ===
			offBg,
	);

	// Switching Pi runtime back to Remote Pi restores the trigger label and Pi path field.
	await app.press("id:settings-ssh-runtime");
	await app.waitFor("text:Remote Pi (SSH host)");
	await app.press("text:Remote Pi (SSH host)");
	await app.waitFor("id:settings-ssh-pi");
	expect(app.shows("id:settings-ssh-local-resources")).toBe(false);
	expect(app.shows("text:Remote Pi (SSH host)")).toBe(true);
	expect(app.shows("text:Local Pi (tools use SSH)")).toBe(false);
});

test("the SSH editor backfills a saved password and includes Pi settings", async () => {
	const app = await openPane();
	await app.press("id:settings-conn-edit-ssh:vault");
	await app.waitFor("id:settings-ssh-password");
	expect(app.shows("text:Edit SSH connection")).toBe(true);
	expect(app.value("id:settings-ssh-password")).toBe("hunter2");
	expect(app.value("id:settings-ssh-host")).toBe("vault-alias");
	expect(app.shows("id:settings-ssh-local-resources")).toBe(true);
	expect(app.shows("id:settings-ssh-proxy")).toBe(false);
	expect(app.shows("id:settings-ssh-pi")).toBe(false);
});

test("the configure dialog detects Pi and saves for Local; SSH edits in one unified dialog", async () => {
	const app = await openPane();
	await app.press("id:settings-conn-configure-local");
	await app.waitFor("id:settings-conn-name");
	expect(app.shows("id:settings-conn-probe")).toBe(true);
	expect(app.shows("id:settings-conn-cancel")).toBe(true);
	await app.press("id:settings-conn-probe");
	await app.waitFor("text:Local Pi is available");
	expect(app.shows("text:pi · 0.20.0")).toBe(true);
	expect(app.value("id:settings-conn-pi")).toBe("pi");
	await app.press("id:settings-conn-cancel");
	expect(app.shows("id:settings-conn-configure-ssh:prod")).toBe(false);
	await app.press("id:settings-conn-edit-ssh:prod");
	await app.waitFor("id:settings-ssh-name");
	await app.clear("id:settings-ssh-name");
	await app.type("id:settings-ssh-name", "renamed-prod");
	await app.press("id:settings-ssh-save");
	await app.waitFor("text:renamed-prod");
});

test("removing a connection asks for confirmation", async () => {
	const app = await openPane();
	await app.press("id:settings-conn-remove-ssh:prod");
	await app.waitFor("text:Remove connection? · prod-server");
	await app.press("id:settings-conn-remove-dialog-confirm");
	await app.waitUntil(() => !app.shows("id:settings-conn-test-ssh:prod"));
	await app.waitFor("text:Removed prod-server");
});

test("on Windows the add menu offers the WSL picker", async () => {
	const app = await openPane("windows");
	await app.press("id:settings-conn-add");
	/* Only the headless engine can pose as Windows; on a real target the
	 * app keeps the host OS and the WSL entry never appears. */
	await app.wait(300);
	if (!app.shows("id:settings-conn-add-wsl")) return;
	await app.press("id:settings-conn-add-wsl");
	await app.waitFor("id:settings-wsl-picker");
	expect(app.shows("text:Add WSL distribution")).toBe(true);
	await app.waitFor("id:settings-wsl-add-Debian");
	expect(app.shows("id:settings-wsl-add-Ubuntu")).toBe(true);
	expect(app.enabled("id:settings-wsl-add-Ubuntu")).toBe(false);
	await app.press("id:settings-wsl-add-Debian");
	await app.waitFor("text:WSL added · Debian");
});
