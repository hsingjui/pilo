import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1200, height: 800 } as const;
/** Lody's `pilo-sidebar-selected-background`, hsl(220 7.5% 39% / 0.1). */
const SELECTED = "#5c616b1a";

function openSidebar(storage: Record<string, string> = {}) {
	return open("./sidebar-projects-fixture.tsx", { ...desktop, storage });
}

type App = Awaited<ReturnType<typeof openSidebar>>;

function collapsedSections(app: App) {
	return JSON.parse(app.storage()["pilo.collapsedSections"] ?? "{}");
}

/**
 * Checks what a press leads to. The press returns before its change is
 * shown or stored, so the check waits for it; a change that never comes
 * fails on the value still there.
 */
async function becomes(app: App, read: () => unknown, expected: unknown) {
	const wanted = JSON.stringify(expected);
	await app.waitUntil(() => JSON.stringify(read()) === wanted).catch(() => {});
	expect(read()).toEqual(expected);
}

const rowColor = (app: App, row: string) => app.viewStyle(row)?.backgroundColor;

/** The tree's texts, after the title bar and the 「新会话」 row over it. */
function treeTexts(app: App) {
	const texts = app.texts();
	return texts.slice(texts.indexOf("Local"));
}

test("projects are listed by connection, the local one first, and start collapsed", async () => {
	const app = await openSidebar();
	await app.waitFor("id:sidebar-projects >> text:pilo");
	expect(treeTexts(app).slice(0, 7)).toEqual([
		"Local",
		"pilo",
		"notes",
		"broken",
		"slow",
		"build-box",
		"api",
	]);
	expect(app.shows("text:No sessions")).toBe(false);
	// The first project is the one a new chat would start in.
	expect(app.viewStyle("id:ws:api:select")?.backgroundColor).toBe(SELECTED);
	expect(app.viewStyle("id:ws:pilo:select")?.backgroundColor).toBeUndefined();
});

test("expanding a project lists its running session, then its five latest", async () => {
	const app = await openSidebar();
	await app.waitFor("id:ws:pilo:toggle");
	await app.press("id:ws:pilo:toggle");
	await app.waitFor("id:session:s1");
	const texts = app.texts();
	expect(texts.slice(texts.indexOf("pilo"), texts.indexOf("notes"))).toEqual([
		"pilo",
		"Port the settings page",
		"Composer",
		"New session",
		"Wire the transcript store",
		"Resize the sidebar",
		"Read the session index",
		"View all",
	]);
	expect(app.count("id:session:s1:running")).toBe(1);
	expect(app.count("id:session:s5:unread")).toBe(1);
	expect(app.count("id:ws:pilo >> id:session:s7:running")).toBe(0);
	expect(app.count("id:ws:pilo >> id:session:s7:unread")).toBe(0);
	expect(collapsedSections(app)).toEqual({ "ws:pilo": false });

	// View all opens the project's own list of every session, in place of
	// the tree; back returns to the tree as it was.
	await app.press("id:ws:pilo:view-all");
	await app.waitFor("id:sidebar-project-view-back >> text:pilo");
	await app.waitFor("id:session:s2 >> text:Dialog test");
	expect(app.shows("id:ws:notes")).toBe(false);
	await app.press("id:sidebar-project-view-back");
	await app.waitFor("id:ws:pilo:view-all");
	expect(app.shows("id:session:s2")).toBe(false);

	await app.press("id:ws:pilo:toggle");
	await app.waitFor("id:session:s1", { state: "gone" });
	await becomes(app, () => collapsedSections(app), { "ws:pilo": true });
});

test("pressing a project or a session opens it and shows it selected", async () => {
	const app = await openSidebar({
		"pilo.collapsedSections": JSON.stringify({ "ws:pilo": false }),
	});
	// A project stored as expanded reads its sessions at launch.
	await app.waitFor("id:session:s7");

	await app.press("id:ws:pilo:select");
	await becomes(app, () => rowColor(app, "id:ws:pilo:select"), SELECTED);
	expect(rowColor(app, "id:ws:api:select")).toBeUndefined();
	// Choosing a project opens its new-chat draft.
	expect(
		app.shows("id:workspace >> text:What would you like to work on today?"),
	).toBe(true);
	expect(app.shows("id:landing-project-picker")).toBe(true);

	await app.press("id:session:s5");
	await becomes(app, () => rowColor(app, "id:session:s5"), SELECTED);
	expect(rowColor(app, "id:ws:pilo:select")).toBeUndefined();
	// Opening an unread session reads it.
	await app.waitUntil(() => !app.shows("id:session:s5:unread"));

	// An open session outside the latest five takes the oldest one's place.
	await app.press("id:ws:pilo:view-all");
	await app.waitFor("id:session:s2");
	await app.press("id:session:s2");
	await becomes(app, () => rowColor(app, "id:session:s2"), SELECTED);
	await app.press("id:sidebar-project-view-back");
	await app.waitFor("id:ws:pilo:toggle");
	await app.press("id:ws:pilo:toggle");
	await app.waitFor("id:session:s2", { state: "gone" });
	await app.press("id:ws:pilo:toggle");
	await app.waitFor("id:session:s2");
	expect(app.shows("id:session:s3")).toBe(false);
	expect(app.shows("id:ws:pilo:view-all")).toBe(true);
});

function sessionReads(app: App, projectId: string) {
	return clientCalls(app).filter(
		(call) => call.call === "listSessions" && call.projectId === projectId,
	).length;
}

/** Expands `projectId` and waits until its sessions are read, twice. */
async function expandAndRead(app: App, projectId: string) {
	await app.press(`id:ws:${projectId}:toggle`);
	await app.waitUntil(
		() =>
			sessionReads(app, projectId) >= 2 &&
			!app.shows(`id:ws:${projectId}:loading`),
	);
}

test("a project explains having no sessions, spins while reading them, and says when that failed", async () => {
	const app = await openSidebar();
	await app.waitFor("id:ws:notes:toggle");

	// An expanded project without sessions explains the empty space.
	await expandAndRead(app, "notes");
	const texts = treeTexts(app);
	expect(texts.slice(texts.indexOf("notes"), texts.indexOf("broken"))).toEqual([
		"notes",
		"No sessions",
	]);
	expect(app.shows("text:No sessions")).toBe(true);

	await app.press("id:ws:broken:toggle");
	await app.waitFor("id:ws:broken:failed");
	expect(app.texts()).toContain("The session index is locked.");

	// A read that has not answered spins on the project's row.
	await app.press("id:ws:slow:toggle");
	await app.waitFor("id:ws:slow:loading");
	expect(app.texts().filter((text) => text === "No sessions")).toHaveLength(1);
});

type ClientCall = Record<string, unknown> & { call: string };

function clientCalls(app: App): ClientCall[] {
	return JSON.parse(app.storage()["pilo.test.clientCalls"] ?? "[]");
}

test("a session row's menu renames it inline and refreshes the list", async () => {
	const app = await openSidebar({
		"pilo.collapsedSections": JSON.stringify({ "ws:pilo": false }),
	});
	await app.waitFor("id:session:s4");

	// A right-click opens the row's menu at the pointer.
	await app.rightClick("id:session:s4");
	await app.waitFor("id:session:s4:rename");

	// Rename switches the row to an input; Enter submits it.
	await app.press("id:session:s4:rename");
	await app.waitFor("id:session:s4:rename-input");
	await app.clear("id:session:s4:rename-input");
	await app.type("id:session:s4:rename-input", "Grow the sidebar");
	await app.keyboard.press("enter");
	const renamed = () =>
		clientCalls(app).filter((call) => call.call === "updateSessionUiState");
	await becomes(app, renamed, [
		{
			call: "updateSessionUiState",
			sessionPath: "/sessions/s4.jsonl",
			update: { pinned: false, titleOverride: "Grow the sidebar" },
			projectId: "pilo",
		},
	]);
	// The renamed entry comes back with the index read the update triggers.
	await app.waitFor("id:session:s4 >> text:Grow the sidebar");

	// Refresh reads the project's sessions again.
	await app.rightClick("id:session:s4");
	await app.waitFor("id:session:s4:refresh");
	const reads = () =>
		clientCalls(app).filter(
			(call) => call.call === "listSessions" && call.projectId === "pilo",
		).length;
	const before = reads();
	await app.press("id:session:s4:refresh");
	await becomes(app, reads, before + 1);
});

test("a session row's delete asks again, then removes and closes it", async () => {
	const app = await openSidebar({
		"pilo.collapsedSections": JSON.stringify({ "ws:pilo": false }),
	});
	await app.waitFor("id:session:s4");
	await app.press("id:session:s4");
	await app.waitFor("id:session-header");

	// The row's trailing button opens the same menu.
	await app.hover("id:session:s4");
	await app.press("id:session:s4:menu");
	await app.waitFor("id:session:s4:delete");

	// The first press only arms the confirm; the menu stays open. Choosing
	// with the keys works on every platform a pointer press may miss on.
	await app.keyboard.press("end");
	await app.keyboard.press("enter");
	await app.waitFor("text:Confirm delete");
	expect(app.shows("id:session:s4")).toBe(true);
	expect(app.shows("id:session-header")).toBe(true);

	await app.keyboard.press("enter");
	await app.waitFor("id:session:s4", { state: "gone" });
	await app.waitFor("text:Session moved to trash");
	expect(clientCalls(app)).toContainEqual({
		call: "deleteSession",
		projectId: "pilo",
		sessionPath: "/sessions/s4.jsonl",
	});
	// Deleting the open session closes it.
	await app.waitFor("id:session-header", { state: "gone" });
});

test("deleting a session notifies on permanent delete and failure", async () => {
	const app = await openSidebar({
		"pilo.collapsedSections": JSON.stringify({ "ws:pilo": false }),
	});
	await app.waitFor("id:session:s3");

	// Permanent unlink shows "Session deleted".
	await app.hover("id:session:s3");
	await app.press("id:session:s3:menu");
	await app.waitFor("id:session:s3:delete");
	await app.keyboard.press("end");
	await app.keyboard.press("enter");
	await app.waitFor("text:Confirm delete");
	await app.keyboard.press("enter");
	await app.waitFor("id:session:s3", { state: "gone" });
	await app.waitFor("text:Session deleted");

	// Failure shows an error toast with the reason and keeps the session row.
	await app.hover("id:session:s6");
	await app.press("id:session:s6:menu");
	await app.waitFor("id:session:s6:delete");
	await app.keyboard.press("end");
	await app.keyboard.press("enter");
	await app.waitFor("text:Confirm delete");
	await app.keyboard.press("enter");
	await app.waitFor("text:Failed to delete session");
	expect(app.shows("text:Permission denied")).toBe(true);
	expect(app.shows("id:session:s6")).toBe(true);
});

test("a connection's projects hide when it is collapsed, and stay hidden next launch", async () => {
	const app = await openSidebar();
	await app.waitFor("id:env:local:toggle");
	await app.press("id:env:local:toggle");
	await app.waitFor("id:ws:pilo", { state: "gone" });
	expect(app.shows("id:ws:api")).toBe(true);
	await becomes(app, () => collapsedSections(app), { "env:local": true });

	const next = await openSidebar(app.storage());
	await next.waitFor("id:ws:api");
	expect(next.shows("id:env:local:toggle")).toBe(true);
	expect(next.shows("id:ws:pilo")).toBe(false);

	await next.press("id:env:local:toggle");
	await next.waitFor("id:ws:pilo");
	await becomes(next, () => collapsedSections(next), { "env:local": false });
});

test("a project row's menu refreshes its sessions from the runtime", async () => {
	const app = await openSidebar();
	await app.waitFor("id:ws:notes:toggle");
	await expandAndRead(app, "notes");
	expect(app.shows("id:session:n1")).toBe(false);

	await app.press("id:ws:notes:menu");
	await app.press("id:ws:notes:menu:refresh");
	await app.waitFor("id:session:n1 >> text:Sketch the notes app");
});

test("a previously saved project order is honored without menu reorder actions", async () => {
	const app = await openSidebar({
		"pilo.sidebarProjectOrder": JSON.stringify({ local: ["notes", "pilo"] }),
	});
	await app.waitFor("id:ws:pilo:menu");
	expect(treeTexts(app).slice(0, 5)).toEqual([
		"Local",
		"notes",
		"pilo",
		"broken",
		"slow",
	]);

	await app.press("id:ws:pilo:menu");
	await app.waitFor("id:ws:pilo:menu:refresh");
	expect(app.shows("id:ws:pilo:menu:remove")).toBe(true);
	expect(app.shows("id:ws:pilo:menu:move-up")).toBe(false);
	expect(app.shows("id:ws:pilo:menu:move-down")).toBe(false);
});

test("removing a project asks once, then drops its row", async () => {
	const app = await openSidebar();
	await app.waitFor("id:ws:broken:menu");

	await app.press("id:ws:broken:menu");
	await app.press("id:ws:broken:menu:remove");
	await app.waitFor("text:Confirm removal");
	expect(app.shows("id:ws:broken")).toBe(true);

	await app.press("id:ws:broken:menu:remove");
	await app.waitFor("id:ws:broken", { state: "gone" });
	expect(app.shows("id:ws:pilo")).toBe(true);
});
