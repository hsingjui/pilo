import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1200, height: 800 } as const;
const VIEW = "pilo.sidebarOrganizeMode";
const SHOW_PROJECTS = "pilo.sidebarShowProjectsInRecents";
/** Lody's `pilo-sidebar-selected-background`, hsl(220 7.5% 39% / 0.1). */
const SELECTED = "#5c616b1a";

/** Every session of the fixture: the running one, then the latest first. */
const RECENT = [
	"Port the settings page",
	"Deploy the build box",
	"Composer",
	"New session",
	"Wire the transcript store",
	"Resize the sidebar",
	"Read the session index",
	"Dialog test",
];

function openSidebar(storage: Record<string, string> = {}) {
	return open("./sidebar-projects-fixture.tsx", { ...desktop, storage });
}

type App = Awaited<ReturnType<typeof openSidebar>>;

/**
 * The sidebar list's texts: after the title bar and the 「新会话」 row, before
 * the workspace pane.
 */
function sidebar(app: App) {
	const texts = app.texts();
	let start = texts.indexOf("New session") + 1;
	if (texts[start] === "⌘N") start += 1;
	const end = texts.findIndex(
		(text, index) =>
			index >= start &&
			(text === "Archived" || text === "What would you like to work on today?"),
	);
	return texts.slice(start, end < 0 ? undefined : end);
}

async function openRecent(storage: Record<string, string> = {}) {
	const app = await openSidebar({ [VIEW]: "recent", ...storage });
	await app.waitFor("id:session:s2");
	return app;
}

test("a connection's menu changes the sidebar to every project's recent sessions", async () => {
	const app = await openSidebar();
	await app.waitFor("id:env:local:menu");
	await app.press("id:env:local:menu");
	await app.waitFor("text:View");
	await app.press("id:view:recent");
	await app.waitFor("id:session:s2");

	expect(sidebar(app)).toEqual(["Recent sessions", ...RECENT]);
	expect(app.shows("id:env:local")).toBe(false);
	expect(app.shows("id:session:s1:running")).toBe(true);
	expect(app.shows("id:session:s5:unread")).toBe(true);
	await app.waitUntil(() => app.storage()[VIEW] === "recent");
});

test("the saved recent view opens at launch and its menu goes back to the projects", async () => {
	const app = await openRecent();
	expect(sidebar(app)).toEqual(["Recent sessions", ...RECENT]);

	await app.press("id:recent:menu");
	await app.waitFor("id:view:projects");
	await app.press("id:view:projects");
	await app.waitFor("id:env:local");
	expect(sidebar(app)).toEqual([
		"Local",
		"pilo",
		"notes",
		"broken",
		"slow",
		"build-box",
		"api",
	]);
	await app.waitUntil(() => app.storage()[VIEW] === "projects");
});

test("recent sessions name their project once the menu's switch is on", async () => {
	const app = await openRecent();
	expect(app.shows("id:session:s8:project")).toBe(false);

	await app.press("id:recent:menu");
	await app.waitFor("id:view:show-projects");
	await app.press("id:view:show-projects");
	await app.waitFor("id:session:s8:project");
	expect(sidebar(app).slice(0, 5)).toEqual([
		"Recent sessions",
		"Port the settings page",
		"pilo",
		"Deploy the build box",
		"api",
	]);
	await app.waitUntil(() => app.storage()[SHOW_PROJECTS] === "1");

	await app.press("id:recent:menu");
	await app.waitFor("id:view:show-projects");
	await app.press("id:view:show-projects");
	await app.waitFor("id:session:s8:project", { state: "gone" });
	await app.waitUntil(() => app.storage()[SHOW_PROJECTS] === "0");
});

test("a recent session opens from the list and the list collapses", async () => {
	const app = await openRecent();
	// The workspace starts on the first project, then shows the session's
	// chat (the fixture's sessions have no messages) in the session's project.
	await app.waitFor("id:landing-project-picker >> text:api");
	await app.press("id:session:s3");
	await app.waitUntil(
		() => app.viewStyle("id:session:s3")?.backgroundColor === SELECTED,
	);
	expect(app.viewStyle("id:session:s8")?.backgroundColor).toBeUndefined();
	await app.waitFor("id:workspace >> id:chat-empty >> text:pilo");

	await app.press("id:recent:toggle");
	await app.waitFor("id:session:s3", { state: "gone" });
	expect(app.shows("id:sidebar >> text:Port the settings page")).toBe(false);
	const collapsed = JSON.stringify({ recent: true });
	await app.waitUntil(
		() => app.storage()["pilo.collapsedSections@local"] === collapsed,
	);

	// The next launch keeps it collapsed once the sessions are read.
	const next = await openSidebar({ ...app.storage() });
	await next.waitFor("id:recent:toggle");
	await next.waitUntil(() => sidebar(next).join() === "Recent sessions");
});

test("the recent view says so when there is no session", async () => {
	const app = await open("./app-shell-states-fixture.tsx", {
		...desktop,
		storage: { "fixture.scenario": "empty", [VIEW]: "recent" },
	});
	await app.waitFor("id:recent:empty");
	expect(sidebar(app).slice(0, 2)).toEqual(["Recent sessions", "No sessions"]);
});
