import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1200, height: 800 } as const;
const FIELD = "label:Search projects, sessions, or messages…";

function openPalette() {
	return open("./command-palette-fixture.tsx", desktop);
}

test("the sidebar search and mod+k open the palette over the sessions of every project", async () => {
	const app = await openPalette();
	await app.waitFor("id:sidebar-search");
	await app.press("id:sidebar-search");
	await app.waitFor(FIELD);
	// The latest sessions of every project, most recent first.
	const texts = app.texts();
	expect(
		texts.slice(
			texts.indexOf("Recent sessions"),
			texts.indexOf("Resize the sidebar") + 1,
		),
	).toEqual([
		"Recent sessions",
		"Deploy the build box",
		"api",
		"Resize the sidebar",
	]);
	await app.keyboard.press("escape");
	await app.waitFor(FIELD, { state: "gone" });
	await app.keyboard.press("mod+k");
	await app.waitFor(FIELD);
	await app.press("id:backdrop").catch(() => app.keyboard.press("escape"));
	await app.waitFor(FIELD, { state: "gone" });
});

test("the palette filters sessions and projects and opens the chosen one", async () => {
	const app = await openPalette();
	await app.waitFor("id:sidebar-search");
	await app.keyboard.press("mod+k");
	await app.waitFor(FIELD);
	await app.type(FIELD, "dialog");
	await app.waitFor("text:Dialog test");
	expect(app.shows("text:Resize the sidebar")).toBe(false);
	await app.clear(FIELD);
	await app.type(FIELD, "/code/api");
	await app.waitFor("text:api");
	await app.keyboard.press("enter");
	// Choosing a project is its new session.
	await app.waitFor(FIELD, { state: "gone" });
	await app.waitFor("id:workspace-title");
});

test("a message match opens its session even under a collapsed project", async () => {
	const app = await openPalette();
	await app.waitFor("id:sidebar-search");
	await app.keyboard.press("mod+k");
	await app.waitFor(FIELD);
	await app.type(FIELD, "resize");
	// Both projects were asked after the debounce; pilo had a match.
	await app.waitFor("text:The sidebar now takes a width.");
	await app.press("text:The sidebar now takes a width.");
	await app.waitFor(FIELD, { state: "gone" });
	await app.waitFor("text:Resize the sidebar");
	// The match came from pilo, but every project was asked.
	await app.waitFor("text:api:resize,pilo:resize");
});

test("the actions run a command: new session lands on the project", async () => {
	const app = await openPalette();
	await app.waitFor("id:sidebar-search");
	await app.press("id:sidebar-search");
	await app.waitFor(FIELD);
	await app.type(FIELD, "new");
	await app.waitFor("text:Actions");
	await app.keyboard.press("enter");
	await app.waitFor(FIELD, { state: "gone" });
	await app.waitFor("id:workspace-title");
	await app.waitFor("text:api");
});
