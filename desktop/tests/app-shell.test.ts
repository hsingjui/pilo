import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 720 } as const;

function openStates(scenario: string) {
	return open("./app-shell-states-fixture.tsx", {
		...desktop,
		storage: { "fixture.scenario": scenario },
	});
}

test("the shell starts on the native runtime and shows the default workspace", async () => {
	const app = await open("./app-shell-fixture.tsx", desktop);
	await app.waitFor("id:workspace-title");
	expect(app.shows("id:sidebar >> text:Pilo")).toBe(true);
	expect(app.shows("id:workspace >> text:Default workspace")).toBe(true);
	expect(app.shows("id:startup-loading")).toBe(false);
	expect(app.shows("id:startup-failed")).toBe(false);
	expect(app.viewStyle("id:sidebar")?.backgroundColor).toBe("#f7f8faff");
	await app.setViewport(390, 844);
	expect(app.shows("id:sidebar >> text:Pilo")).toBe(true);
	expect(app.shows("id:workspace-title")).toBe(true);
});

test("the shell says it is loading until the first snapshot arrives", async () => {
	const app = await openStates("starting");
	expect(app.shows("id:workspace >> text:Loading…")).toBe(true);
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
	expect(app.texts()).toContain("/Users/pilo/code/pilo");
	expect(app.shows("id:startup-failed")).toBe(false);
});

test("a ready app without projects asks for one", async () => {
	const app = await openStates("empty");
	await app.waitFor("id:workspace-title");
	expect(app.shows("id:workspace >> text:Add a project first")).toBe(true);
	expect(app.shows("id:startup-failed")).toBe(false);
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
	expect(app.shows("id:sidebar")).toBe(false);
	expect(app.shows("id:main-title-bar >> id:sidebar-expand")).toBe(true);
	expect(app.shows("id:workspace-title")).toBe(true);

	await app.press("id:sidebar-expand");
	expect(app.shows("id:sidebar >> text:Pilo")).toBe(true);
	expect(app.shows("id:sidebar-expand")).toBe(false);
});

test("a narrow window keeps the workspace once the sidebar is collapsed", async () => {
	const app = await openStates("empty");
	await app.waitFor("id:workspace-title");
	await app.setViewport(390, 720);
	expect(app.shows("id:sidebar-collapse")).toBe(true);
	await app.press("id:sidebar-collapse");
	expect(app.shows("id:workspace >> text:Add a project first")).toBe(true);
});

test("the shell fixtures show the theme saved in their Host", async () => {
	const claude = { "fixture.theme": "claude" };
	const sidebar = (app: Awaited<ReturnType<typeof open>>) =>
		app.viewStyle("id:sidebar")?.backgroundColor;

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
