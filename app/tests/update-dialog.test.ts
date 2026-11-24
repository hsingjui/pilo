import { expect, open, test } from "nsh/test";

type Mode =
	| "available"
	| "empty-notes"
	| "failed-notes-then-recover"
	| "download-error"
	| "manual-open"
	| "preview";

async function openApp(mode: Mode = "available") {
	const app = await open("./update-dialog-fixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 760,
		locale: "en-US",
		host: { params: { mode } },
	});
	await app.waitFor("id:sidebar-settings");
	return app;
}

async function readFixtureState(app: Awaited<ReturnType<typeof openApp>>) {
	const raw = (await app.storage())["update-fixture-state"];
	return raw
		? (JSON.parse(raw) as {
				checkCalls: number;
				installCalls: number;
				notesAttempts: number;
				openedUrls: string[];
			})
		: null;
}

test("startup check shows sidebar update trigger and opens release notes with installer footer stripped", async () => {
	const app = await openApp("available");
	await app.waitFor("id:sidebar-update");
	expect(app.shows("id:update-dialog")).toBe(false);
	expect(app.shows("text:Update")).toBe(true);

	await app.press("id:sidebar-update");
	await app.waitFor("id:update-dialog");
	await app.waitFor("text:Added native update dialog");

	expect(app.shows("text:Update available")).toBe(true);
	expect(
		app.shows(
			"text:Pilo v0.5.0 is available. The app will restart after installation.",
		),
	).toBe(true);
	expect(app.shows("id:update-dialog-github-releases")).toBe(true);
	expect(
		app.shows("text:This installer footer should stay on GitHub only."),
	).toBe(false);

	await app.press("id:update-dialog-github-releases");
	const state = await readFixtureState(app);
	expect(state?.openedUrls).toContain(
		"https://github.com/hsingjui/pilo/releases/tag/v0.5.0",
	);
});

test("download progress updates in dialog, persists when closed, and completes install", async () => {
	const app = await openApp("available");
	await app.waitFor("id:sidebar-update");
	await app.press("id:sidebar-update");
	await app.waitFor("id:update-dialog-install");

	await app.press("id:update-dialog-install");
	await app.waitFor("id:update-dialog-progress");
	expect(
		app.shows(
			"text:Closing this dialog will not stop the update. The app will restart after installation.",
		),
	).toBe(true);

	await app.host.send("fixture", "progress-40");
	await app.waitFor("text:40%");
	expect(app.shows("text:4.0 MB / 10.0 MB")).toBe(true);

	// Closing the dialog keeps downloading and reflects progress on the sidebar button.
	await app.press("id:update-dialog-close-action");
	await app.waitFor("id:update-dialog", { state: "gone" });
	expect(app.shows("text:40%")).toBe(true);

	// Reopening from About pane also reopens the active download dialog.
	await app.press("id:sidebar-settings");
	await app.waitFor("id:settings-nav-about");
	await app.press("id:settings-nav-about");
	await app.waitFor("id:settings-update-check");
	expect(app.shows("text:Downloading… 40%")).toBe(true);
	await app.press("id:settings-update-check");
	await app.waitFor("id:update-dialog");

	await app.host.send("fixture", "finish-download");
	await app.waitFor("text:Installing…");
	const state = await readFixtureState(app);
	expect(state?.installCalls).toBe(1);
});

test("empty release notes show the empty fallback message", async () => {
	const app = await openApp("empty-notes");
	await app.waitFor("id:sidebar-update");
	await app.press("id:sidebar-update");
	await app.waitFor("text:No release notes were provided for this version.");
});

test("failed release notes show fallback notes and retry on reopen", async () => {
	const app = await openApp("failed-notes-then-recover");
	await app.waitFor("id:sidebar-update");
	await app.press("id:sidebar-update");
	await app.waitFor(
		"text:Release notes could not be loaded. View them on GitHub Releases, or continue with the update.",
	);
	expect(app.shows("text:Manifest fallback summary")).toBe(true);

	await app.press("id:update-dialog-close");
	await app.waitFor("id:update-dialog", { state: "gone" });
	await app.press("id:sidebar-update");
	await app.waitFor("text:Retry succeeded");
	expect(
		app.shows(
			"text:Release notes could not be loaded. View them on GitHub Releases, or continue with the update.",
		),
	).toBe(false);
});

test("download failure shows error state and retry triggers a fresh check", async () => {
	const app = await openApp("download-error");
	await app.waitFor("id:sidebar-update");
	await app.press("id:sidebar-update");
	await app.waitFor("id:update-dialog-install");

	await app.press("id:update-dialog-install");
	await app.waitFor("id:update-dialog-error");
	expect(
		app.shows(
			"text:Unable to connect to the update service. Check the network and try again.",
		),
	).toBe(true);
	expect(app.shows("text:Retry")).toBe(true);

	await app.press("id:update-dialog-close-action");
	await app.waitFor("id:update-dialog", { state: "gone" });
	expect(app.shows("text:View update")).toBe(true);

	await app.press("id:sidebar-update");
	await app.waitFor("id:update-dialog-install");
	await app.press("id:update-dialog-install");
	await app.waitFor("text:Download and install");
	const state = await readFixtureState(app);
	expect(state?.checkCalls).toBe(2);
});

test("non-installable updates open the release URL instead of downloading", async () => {
	const app = await openApp("manual-open");
	await app.waitFor("id:sidebar-update");
	await app.press("id:sidebar-update");
	await app.waitFor("id:update-dialog-install");
	await app.press("id:update-dialog-install");

	const state = await readFixtureState(app);
	expect(state?.openedUrls).toContain(
		"https://github.com/hsingjui/pilo/releases/tag/v0.5.0",
	);
	expect(state?.installCalls).toBe(0);
});

test("dev preview button in About opens preview dialog and shows preview-only toast on install", async () => {
	const app = await openApp("preview");
	expect(app.shows("id:sidebar-update")).toBe(false);

	await app.press("id:sidebar-settings");
	await app.waitFor("id:settings-nav-about");
	await app.press("id:settings-nav-about");
	await app.waitFor("id:settings-update-preview");

	await app.press("id:settings-update-preview");
	await app.waitFor("id:update-dialog");
	expect(
		app.shows(
			"text:Pilo v99.0.0-preview is available. The app will restart after installation.",
		),
	).toBe(true);
	expect(app.shows("id:update-dialog-github-releases")).toBe(false);
	expect(
		app.shows("text:Preview only — no update will be downloaded or installed."),
	).toBe(true);

	await app.press("id:update-dialog-install");
	// Preview mode must never invoke real download/install.
	const state = await readFixtureState(app);
	expect(state).toBeNull();
});
