import { expect, open, test } from "nsh/test";

const LEGACY_SECTIONS = "pilo.collapsedSections";
const LEGACY_ORDER = "pilo.sidebarProjectOrder";
const SECTIONS = "pilo.collapsedSections@local";
const ORDER = "pilo.sidebarProjectOrder@local";
const VIEW = "pilo.sidebarOrganizeMode";
const SHOW_PROJECTS = "pilo.sidebarShowProjectsInRecents";

async function openSettings(
	storage: Record<string, string> = {},
	hostId?: string,
) {
	const app = await open("./sidebar-settings-fixture.tsx", {
		storage: hostId ? { ...storage, "fixture.hostId": hostId } : storage,
	});
	await app.waitFor("text:loaded: true");
	return app;
}

test("the sidebar starts in the projects view with nothing stored", async () => {
	const app = await openSettings();
	expect(app.texts()).toContain("view: projects");
	expect(app.texts()).toContain("show projects: false");
	expect(app.texts()).toContain("sections: {}");
	expect(app.storage()).toEqual({});
});

test("the sidebar migrates its old order and collapse state and keeps global preferences", async () => {
	const sections = '{"ws:p1":true,"env:local":false}';
	const order = '{"local":["notes","pilo"]}';
	const app = await openSettings({
		[LEGACY_SECTIONS]: sections,
		[LEGACY_ORDER]: order,
		[VIEW]: "recent",
		[SHOW_PROJECTS]: "1",
	});
	expect(app.texts()).toContain("view: recent");
	expect(app.texts()).toContain("show projects: true");
	expect(app.texts()).toContain('sections: {"ws:p1":true,"env:local":false}');
	expect(app.texts()).toContain(`order: ${order}`);
	expect(app.storage()).toEqual({
		[SECTIONS]: sections,
		[ORDER]: order,
		[VIEW]: "recent",
		[SHOW_PROJECTS]: "1",
	});
	const reopened = await openSettings(app.storage());
	expect(reopened.texts()).toContain(`sections: ${sections}`);
	expect(reopened.texts()).toContain(`order: ${order}`);
});

test("another Host reads only its own sidebar settings", async () => {
	const legacy = '{"ws:p1":true}';
	const app = await openSettings(
		{
			[LEGACY_SECTIONS]: legacy,
			[SECTIONS]: legacy,
			[`${LEGACY_SECTIONS}@other`]: '{"ws:p2":false}',
		},
		"other",
	);
	expect(app.texts()).toContain('sections: {"ws:p2":false}');
	expect(app.storage()[LEGACY_SECTIONS]).toBe(legacy);
});

test("stored values of the wrong shape fall back to the defaults", async () => {
	const mixed = await openSettings({
		[SECTIONS]:
			'{"ws:p1":true,"env:local":"yes","ws:p3":0,"ws:p4":null,"ws:p5":false}',
		[VIEW]: "grid",
		[SHOW_PROJECTS]: "true",
	});
	expect(mixed.texts()).toContain("view: projects");
	expect(mixed.texts()).toContain("show projects: false");
	expect(mixed.texts()).toContain('sections: {"ws:p1":true,"ws:p5":false}');

	for (const sections of ["{not json", "[true]", "null", '"ws:p1"', "7"]) {
		const app = await openSettings({ [SECTIONS]: sections });
		expect(app.texts()).toContain("sections: {}");
	}
});

test("changed settings are saved and read back by the next launch", async () => {
	const app = await openSettings({ [SECTIONS]: '{"recent":true}' });
	await app.press("Use recent");
	await app.press("Show projects");
	await app.press("Collapse ws:p1");
	await app.press("Expand env:local");
	// A press returns before its change is shown and stored.
	await app.waitUntil(
		() => app.storage()[SECTIONS]?.includes("env:local") ?? false,
	);
	expect(app.texts()).toContain("view: recent");
	expect(app.texts()).toContain("show projects: true");
	const saved = app.storage();
	expect(saved).toEqual({
		[SECTIONS]: '{"recent":true,"ws:p1":true,"env:local":false}',
		[VIEW]: "recent",
		[SHOW_PROJECTS]: "1",
	});

	const next = await openSettings(saved);
	expect(next.texts()).toContain("view: recent");
	expect(next.texts()).toContain("show projects: true");
	expect(next.texts()).toContain(
		'sections: {"recent":true,"ws:p1":true,"env:local":false}',
	);

	await next.press("Use projects");
	await next.press("Hide projects");
	await next.waitUntil(() => next.storage()[SHOW_PROJECTS] === "0");
	expect(next.storage()[VIEW]).toBe("projects");
});
