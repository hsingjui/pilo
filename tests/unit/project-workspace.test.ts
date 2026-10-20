import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_GIT_WORKSPACE_VIEW,
	reduceProjectWorkspaces,
	workspaceFileKey,
	type ProjectWorkspace,
} from "../../src/lib/project-workspace.ts";
import {
	fileLinkPreviewKind,
	resolveMarkdownFileUrl,
} from "../../src/lib/chat/chat-markdown-links.ts";

const empty = () => new Map<string, ProjectWorkspace>();
const file = (path: string) => ({ path, content: `contents of ${path}` });

test("files deduplicate by path, reuse content and stay isolated by project", () => {
	const first = file("\\\\?\\C:\\repo\\main.ts");
	let state = reduceProjectWorkspaces(empty(), {
		type: "open",
		projectId: "a",
		file: first,
	});
	state = reduceProjectWorkspaces(state, {
		type: "select",
		projectId: "a",
		path: null,
	});
	state = reduceProjectWorkspaces(state, {
		type: "open",
		projectId: "a",
		file: file("c:/repo/main.ts"),
	});
	assert.deepEqual(state.get("a"), {
		files: [first],
		gitOpen: false,
		activeTab: { kind: "file", path: first.path },
	});
	assert.equal(
		workspaceFileKey(first.path),
		workspaceFileKey("C:\\repo\\main.ts"),
	);
	state = reduceProjectWorkspaces(state, {
		type: "open",
		projectId: "b",
		file: file("/other/main.ts"),
	});
	assert.deepEqual(state.get("a")?.activeTab, {
		kind: "file",
		path: first.path,
	});
	assert.equal(state.get("b")?.files.length, 1);
	assert.notEqual(
		workspaceFileKey("/Repo/Main.ts"),
		workspaceFileKey("/Repo/main.ts"),
	);
});

test("closing files selects a neighbor or chat and never changes another project's tabs", () => {
	let state = empty();
	for (const name of ["one", "two", "three"])
		state = new Map(
			reduceProjectWorkspaces(state, {
				type: "open",
				projectId: "a",
				file: file(name),
			}),
		);
	let next = reduceProjectWorkspaces(state, {
		type: "close",
		projectId: "a",
		path: "one",
	});
	assert.deepEqual(next.get("a")?.activeTab, { kind: "file", path: "three" });
	next = reduceProjectWorkspaces(next, {
		type: "close",
		projectId: "a",
		path: "three",
	});
	assert.deepEqual(next.get("a")?.activeTab, { kind: "file", path: "two" });
	next = reduceProjectWorkspaces(next, {
		type: "close",
		projectId: "a",
		path: "two",
	});
	assert.deepEqual(next.get("a")?.activeTab, { kind: "chat" });
	assert.equal(next.get("a")?.files.length, 0);
	assert.equal(
		reduceProjectWorkspaces(next, {
			type: "select",
			projectId: "a",
			path: "missing",
		}),
		next,
	);
});

test("chat selection retains files, stale highlights cannot overwrite a reopened file, deletion releases caches", () => {
	const original = file("/repo/a.ts");
	let state = reduceProjectWorkspaces(empty(), {
		type: "open",
		projectId: "a",
		file: original,
	});
	state = reduceProjectWorkspaces(state, {
		type: "select",
		projectId: "a",
		path: null,
	});
	assert.equal(state.get("a")?.files[0], original);
	state = reduceProjectWorkspaces(state, {
		type: "highlight",
		projectId: "a",
		file: original,
		html: "<pre>code</pre>",
	});
	assert.equal(state.get("a")?.files[0]?.html, "<pre>code</pre>");
	state = reduceProjectWorkspaces(state, {
		type: "close",
		projectId: "a",
		path: original.path,
	});
	state = reduceProjectWorkspaces(state, {
		type: "open",
		projectId: "a",
		file: file(original.path),
	});
	assert.equal(
		reduceProjectWorkspaces(state, {
			type: "highlight",
			projectId: "a",
			file: original,
			html: "stale",
		}),
		state,
	);
	assert.equal(
		reduceProjectWorkspaces(state, { type: "prune", projectIds: [] }).size,
		0,
	);
});

test("Git opens once per project and selecting chat or a file keeps it open", () => {
	const first = file("main.ts");
	let state = reduceProjectWorkspaces(empty(), {
		type: "open",
		projectId: "a",
		file: first,
	});
	state = reduceProjectWorkspaces(state, { type: "open-git", projectId: "a" });
	assert.deepEqual(state.get("a"), {
		files: [first],
		gitOpen: true,
		activeTab: { kind: "git" },
	});
	assert.equal(
		reduceProjectWorkspaces(state, { type: "open-git", projectId: "a" }),
		state,
	);
	const projectA = state.get("a");
	state = reduceProjectWorkspaces(state, { type: "open-git", projectId: "b" });
	assert.equal(state.get("a"), projectA);
	assert.deepEqual(state.get("b"), {
		files: [],
		gitOpen: true,
		activeTab: { kind: "git" },
	});
	for (const path of [first.path, null]) {
		state = reduceProjectWorkspaces(state, {
			type: "select",
			projectId: "a",
			path,
		});
		assert.deepEqual(
			state.get("a")?.activeTab,
			path === null ? { kind: "chat" } : { kind: "file", path },
		);
		assert.equal(state.get("a")?.gitOpen, true);
		assert.deepEqual(state.get("a")?.files, [first]);
	}
});

test("closing Git selects a file or chat and leaves inactive selections alone", () => {
	for (const selection of ["git", "file", "chat"] as const) {
		let state = reduceProjectWorkspaces(empty(), {
			type: "open-git",
			projectId: "a",
		});
		for (const path of ["one", "two"])
			state = reduceProjectWorkspaces(state, {
				type: "open",
				projectId: "a",
				file: file(path),
			});
		if (selection === "git")
			state = reduceProjectWorkspaces(state, {
				type: "open-git",
				projectId: "a",
			});
		if (selection === "chat")
			state = reduceProjectWorkspaces(state, {
				type: "select",
				projectId: "a",
				path: null,
			});
		state = reduceProjectWorkspaces(state, {
			type: "close-git",
			projectId: "a",
		});
		assert.equal(state.get("a")?.gitOpen, false);
		assert.deepEqual(
			state.get("a")?.activeTab,
			selection === "chat"
				? { kind: "chat" }
				: { kind: "file", path: selection === "git" ? "one" : "two" },
		);
		assert.equal(
			reduceProjectWorkspaces(state, { type: "close-git", projectId: "a" }),
			state,
		);
	}
	let state = reduceProjectWorkspaces(empty(), {
		type: "open-git",
		projectId: "a",
	});
	state = reduceProjectWorkspaces(state, { type: "close-git", projectId: "a" });
	assert.deepEqual(state.get("a")?.activeTab, { kind: "chat" });
});

test("closing the last selected file returns to the open Git tab", () => {
	let state = reduceProjectWorkspaces(empty(), {
		type: "open-git",
		projectId: "a",
	});
	state = reduceProjectWorkspaces(state, {
		type: "open",
		projectId: "a",
		file: file("main.ts"),
	});
	state = reduceProjectWorkspaces(state, {
		type: "close",
		projectId: "a",
		path: "main.ts",
	});
	assert.deepEqual(state.get("a"), {
		files: [],
		gitOpen: true,
		activeTab: { kind: "git" },
	});
});

test("Git view patches preserve project preferences through tab switches and reopening", () => {
	let state = reduceProjectWorkspaces(empty(), {
		type: "open-git",
		projectId: "a",
	});
	state = reduceProjectWorkspaces(state, {
		type: "update-git-view",
		projectId: "a",
		view: { mode: "staged", selectedPath: "main.ts", showDetail: true },
	});
	assert.deepEqual(state.get("a")?.gitView, {
		...DEFAULT_GIT_WORKSPACE_VIEW,
		mode: "staged",
		selectedPath: "main.ts",
		showDetail: true,
	});
	state = reduceProjectWorkspaces(state, {
		type: "update-git-view",
		projectId: "a",
		view: { listWidth: 32, diffStyle: "unified", wrapLines: true },
	});
	const view = state.get("a")?.gitView;
	assert.deepEqual(view, {
		mode: "staged",
		selectedPath: "main.ts",
		showDetail: true,
		listWidth: 32,
		diffStyle: "unified",
		wrapLines: true,
	});
	// Conversation/new-chat selection shares the project workspace's chat action.
	state = reduceProjectWorkspaces(state, {
		type: "select",
		projectId: "a",
		path: null,
	});
	state = reduceProjectWorkspaces(state, {
		type: "open",
		projectId: "a",
		file: file("other.ts"),
	});
	assert.equal(state.get("a")?.gitView, view);
	state = reduceProjectWorkspaces(state, { type: "open-git", projectId: "b" });
	assert.equal(state.get("a")?.gitView, view);
	assert.equal(state.get("b")?.gitView, undefined);
	state = reduceProjectWorkspaces(state, { type: "close-git", projectId: "a" });
	assert.equal(
		reduceProjectWorkspaces(state, {
			type: "update-git-view",
			projectId: "a",
			view: { mode: "working" },
		}),
		state,
		"a late view update must not affect a closed Git tab",
	);
	state = reduceProjectWorkspaces(state, { type: "open-git", projectId: "a" });
	assert.equal(state.get("a")?.gitView, view);
	assert.deepEqual(state.get("a")?.activeTab, { kind: "git" });
	const projectB = state.get("b");
	state = reduceProjectWorkspaces(state, { type: "prune", projectIds: ["b"] });
	assert.equal(state.has("a"), false);
	assert.equal(state.get("b"), projectB);
	assert.equal(
		reduceProjectWorkspaces(state, {
			type: "update-git-view",
			projectId: "a",
			view: { listWidth: 40 },
		}),
		state,
		"a late view update must not recreate a removed project",
	);
	assert.deepEqual(DEFAULT_GIT_WORKSPACE_VIEW, {
		mode: "working",
		selectedPath: null,
		showDetail: false,
		diffStyle: "split",
		wrapLines: false,
	});
});

test("Markdown and common source files preview, HTML/documents use the default application", () => {
	for (const path of ["README.md", "notes.MARKDOWN"])
		assert.equal(fileLinkPreviewKind(path), "markdown");
	for (const path of [
		"main.ts",
		"App.tsx",
		"main.py",
		"lib.rs",
		"main.cpp",
		"App.java",
		"config.toml",
		"Dockerfile",
		"Makefile",
		".env",
		"C:\\repo\\app.vue",
		"notes.txt",
		"component.mdx",
		"script.sh",
	])
		assert.equal(fileLinkPreviewKind(path), "code", path);
	for (const path of [
		"report.html",
		"report.HTM",
		"document.pdf",
		"image.png",
		"archive.zip",
		"program.exe",
		"link.lnk",
	])
		assert.equal(fileLinkPreviewKind(path), null, path);
	for (const name of ["README.md", "main.ts", "document.pdf", "image.png"])
		assert.ok(resolveMarkdownFileUrl(`file:///tmp/${name}`));
});
