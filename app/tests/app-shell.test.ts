import { expect, open, test } from "nsh/test";

import config from "../../nsh.json";

const desktop = { platform: "macos", width: 1100, height: 720 } as const;

function openStates(scenario: string) {
	return open("./app-shell-states-fixture.tsx", {
		...desktop,
		storage: { "fixture.scenario": scenario },
	});
}

test("the shell starts on the native runtime and lands on the default workspace", async () => {
	const app = await open("./app-shell-fixture.tsx", desktop);
	await app.waitFor("id:workspace-title");
	// As React's tree, the default workspace stays out of the sidebar until
	// its connection's menu shows it; the landing's picker starts on it.
	expect(app.shows("id:sidebar >> text:Default workspace")).toBe(false);
	expect(app.shows("id:landing-project-picker >> text:Default workspace")).toBe(
		true,
	);
	expect(app.shows("id:startup-loading")).toBe(false);
	expect(app.shows("id:startup-failed")).toBe(false);
	expect(app.viewStyle("id:sidebar-surface")?.backgroundColor).toBe(
		"#f7f8faff",
	);
});

test("the shell says it is loading until the first snapshot arrives", async () => {
	const app = await openStates("starting");
	expect(app.shows("id:workspace >> label:Loading…")).toBe(true);
	expect(app.shows("id:workspace-title")).toBe(false);
	expect(app.shows("id:startup-failed")).toBe(false);
});

test("a failed startup shows its error and recovers on retry", async () => {
	const app = await openStates("failed");
	await app.waitFor("id:startup-failed");
	expect(app.shows("id:startup-failed >> text:Failed to load")).toBe(true);
	expect(
		app.shows("id:startup-failed >> text:The Pilo database is locked."),
	).toBe(true);
	expect(app.shows("id:workspace-title")).toBe(false);

	await app.press("id:startup-retry");
	await app.waitFor("id:startup-failed >> text:The Pi runtime is missing.");
	expect(app.shows("text:The Pilo database is locked.")).toBe(false);
	expect(app.enabled("id:startup-retry")).toBe(true);

	await app.press("id:startup-retry");
	await app.waitFor("id:workspace >> text:pilo");
	expect(app.shows("id:landing-project-picker")).toBe(true);
	expect(app.shows("id:startup-failed")).toBe(false);
});

test("a ready app without projects asks for one", async () => {
	const app = await openStates("empty");
	await app.waitFor("id:workspace-title");
	expect(app.shows("id:workspace >> text:Add a project first")).toBe(true);
	expect(app.shows("id:landing-add-project")).toBe(true);
	expect(app.shows("id:landing-project-picker")).toBe(false);
	expect(app.shows("id:startup-failed")).toBe(false);
});

test("the landing adds a project through the dialog", async () => {
	const app = await openStates("empty");
	await app.waitFor("id:workspace-title");

	await app.press("id:landing-add-project");
	await app.waitFor("id:add-project-dialog");
	expect(app.shows("id:add-project-path")).toBe(true);
	expect(app.enabled("id:add-project-confirm")).toBe(false);

	await app.type("id:add-project-path", "/code/added-project");
	expect(app.enabled("id:add-project-confirm")).toBe(true);
	await app.press("id:add-project-confirm");

	await app.waitFor("id:landing-project-picker");
	expect(app.shows("id:add-project-dialog")).toBe(false);
	expect(app.texts()).toContain("added-project");
});

test("a runtime that shut down says so and asks for a restart", async () => {
	const app = await openStates("closed");
	await app.waitFor("id:runtime-stopped");
	expect(app.shows("id:runtime-stopped >> text:Pilo's runtime stopped")).toBe(
		true,
	);
	expect(
		app.shows("id:runtime-stopped >> text:Restart Pilo to continue."),
	).toBe(true);
	expect(app.shows("id:startup-failed")).toBe(false);
	expect(app.shows("id:startup-retry")).toBe(false);
	expect(app.shows("id:workspace-title")).toBe(false);
});

test("the sidebar collapses and expands from the title bar", async () => {
	const app = await openStates("empty");
	await app.waitFor("id:workspace-title");
	expect(app.shows("id:sidebar-title-bar >> id:sidebar-collapse")).toBe(true);
	expect(app.shows("id:sidebar-expand")).toBe(false);

	await app.press("id:sidebar-collapse");
	await app.waitFor("id:sidebar", { state: "gone" });
	await app.waitFor("id:main-title-bar >> id:sidebar-expand");
	expect(app.shows("id:workspace-title")).toBe(true);

	await app.press("id:sidebar-expand");
	await app.waitFor("id:sidebar >> id:sidebar-projects");
	await app.waitFor("id:sidebar-expand", { state: "gone" });
	expect(app.shows("id:sidebar-new-chat >> text:New session")).toBe(true);
});

test("the smallest window shows the sidebar beside the workspace", async () => {
	const app = await open("./app-shell-states-fixture.tsx", {
		platform: "macos",
		...config.window.minSize,
		storage: { "fixture.scenario": "empty" },
	});
	await app.waitFor("id:workspace-title");
	expect(config.window.minSize.width).toBe(768);
	expect(config.window.minSize.height).toBe(600);
	expect(app.shows("id:sidebar >> id:sidebar-projects")).toBe(true);
	expect(app.shows("id:sidebar-collapse")).toBe(true);
	expect(app.shows("id:workspace >> text:Add a project first")).toBe(true);
});

test("the shell fixtures show the theme saved in their Host", async () => {
	const claude = { "fixture.theme": "claude" };
	const sidebar = (app: Awaited<ReturnType<typeof open>>) =>
		app.viewStyle("id:sidebar-surface")?.backgroundColor;

	const native = await open("./app-shell-fixture.tsx", {
		...desktop,
		storage: claude,
	});
	await native.waitFor("id:workspace-title");
	expect(sidebar(native)).toBe("#fafaf9ff");

	const scripted = await open("./app-shell-states-fixture.tsx", {
		...desktop,
		storage: { ...claude, "fixture.scenario": "empty" },
	});
	await scripted.waitFor("id:workspace-title");
	expect(sidebar(scripted)).toBe("#fafaf9ff");

	// No theme is known before the first snapshot: the shell stays in Lody.
	const starting = await open("./app-shell-states-fixture.tsx", {
		...desktop,
		storage: { ...claude, "fixture.scenario": "starting" },
	});
	expect(sidebar(starting)).toBe("#f7f8faff");
});
