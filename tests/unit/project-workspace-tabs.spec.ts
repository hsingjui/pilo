import assert from "node:assert/strict";
import test from "node:test";

import {
	computeMaxVisibleAuxTabs,
	partitionHeaderTabs,
	workspaceFileIconKind,
} from "../../shared/project-workspace-tabs.ts";

test("workspaceFileIconKind classifies common project files consistently", () => {
	assert.equal(workspaceFileIconKind("docs/README.md"), "text");
	assert.equal(workspaceFileIconKind("LICENSE"), "text");
	assert.equal(workspaceFileIconKind("package.json"), "json");
	assert.equal(workspaceFileIconKind("config/settings.yaml"), "config");
	assert.equal(workspaceFileIconKind(".env.local"), "config");
	assert.equal(workspaceFileIconKind("scripts/build.sh"), "terminal");
	assert.equal(workspaceFileIconKind("Dockerfile"), "terminal");
	assert.equal(workspaceFileIconKind("web/styles.css"), "style");
	assert.equal(workspaceFileIconKind("notes"), "file");
	assert.equal(workspaceFileIconKind("desktop/app/AppShell.tsx"), "code");
});

test("computeMaxVisibleAuxTabs falls back before layout and scales with available width", () => {
	assert.equal(computeMaxVisibleAuxTabs(0, true), 4);
	assert.equal(computeMaxVisibleAuxTabs(Number.NaN, true), 4);
	assert.equal(computeMaxVisibleAuxTabs(220, true), 1);
	assert.equal(computeMaxVisibleAuxTabs(660, true), 3);
	assert.equal(computeMaxVisibleAuxTabs(660, false), 4);
	assert.equal(computeMaxVisibleAuxTabs(2000, true), 8);
});

test("partitionHeaderTabs keeps all tabs visible within capacity and promotes an active overflow tab", () => {
	const items = [
		{ id: "git" },
		{ id: "file:a.ts" },
		{ id: "file:b.ts" },
		{ id: "file:c.ts" },
		{ id: "term:1" },
	];

	assert.deepEqual(partitionHeaderTabs(items, "file:b.ts", 5), {
		visible: items,
		overflow: [],
	});

	assert.deepEqual(partitionHeaderTabs(items, "file:a.ts", 3), {
		visible: [{ id: "git" }, { id: "file:a.ts" }, { id: "file:b.ts" }],
		overflow: [{ id: "file:c.ts" }, { id: "term:1" }],
	});

	assert.deepEqual(partitionHeaderTabs(items, "term:1", 3), {
		visible: [{ id: "git" }, { id: "file:a.ts" }, { id: "term:1" }],
		overflow: [{ id: "file:b.ts" }, { id: "file:c.ts" }],
	});

	assert.deepEqual(partitionHeaderTabs(items, null, 2), {
		visible: [{ id: "git" }, { id: "file:a.ts" }],
		overflow: [{ id: "file:b.ts" }, { id: "file:c.ts" }, { id: "term:1" }],
	});
});
