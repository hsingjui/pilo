import { expect, open, test } from "nsh/test";

const wideDesktop = {
	platform: "macos",
	width: 1200,
	height: 800,
	locale: "en-US",
} as const;

const narrowDesktop = {
	platform: "macos",
	width: 520,
	height: 800,
	locale: "en-US",
} as const;

test("opens Git tab once, renders branch/files/diff, switches working/staged, opens file preview, and isolates projects", async () => {
	const app = await open("./git-workspace-fixture.tsx", wideDesktop);
	await app.waitFor("text:Chat in Demo");

	// Open Git from the header button.
	await app.press("id:header-open-git");
	await app.waitFor("id:git-tab");
	await app.waitFor("id:git-diff-view");

	expect(app.shows("id:git-branch-badge >> text:feat/git-panel")).toBe(true);
	expect(app.shows("id:git-file-count >> text:3")).toBe(true);
	expect(app.shows("id:git-diff-pane >> text:app.ts")).toBe(true);
	expect(app.shows("id:git-diff-pane >> text:src/app.ts")).toBe(true);

	// Repeated activation keeps a single Git tab.
	await app.press("id:header-open-git");
	expect(app.shows("id:git-tab")).toBe(true);

	// Toggle unified / split and wrap lines.
	await app.press("id:git-diff-layout-unified");
	await app.waitFor("text:view:working:unified:nowrap:none");
	await app.press("id:git-diff-wrap");
	await app.waitFor("text:view:working:unified:wrap:none");

	// Select another file in working tree.
	await app.press("id:git-file-row:notes.md");
	await app.waitFor("id:git-diff-pane >> text:notes.md");
	await app.waitFor("id:git-diff-view");

	// Switch to Staged mode and verify staged file + diff.
	await app.press("id:git-mode-staged");
	await app.waitFor("id:git-file-row:src/staged.ts");
	await app.waitFor("id:git-diff-pane >> text:staged.ts");
	await app.waitFor("id:git-diff-view");

	// Switch back to Working tree, select src/app.ts and open it in a file preview tab.
	await app.press("id:git-mode-working");
	await app.press("id:git-file-row:src/app.ts");
	await app.waitFor("id:git-diff-pane >> text:app.ts");
	await app.press("id:git-open-file");
	await app.waitFor("id:file-tab:/work/demo/src/app.ts");
	await app.waitFor("id:file-preview-editor");

	// Closing the last file tab returns to the open Git tab.
	await app.press("id:file-tab-close:/work/demo/src/app.ts");
	await app.waitUntil(() => !app.shows("id:file-tab:/work/demo/src/app.ts"));
	await app.waitFor("id:git-diff-view");

	// Switching to project p2 isolates p1's Git tab and view preferences.
	await app.press("id:switch-project");
	await app.waitFor("text:Chat in Other");
	expect(app.shows("id:git-tab")).toBe(false);

	// Opening Git in p2 shows clean working tree empty state.
	await app.press("id:header-open-git");
	await app.waitFor("id:git-files-empty");
	expect(app.shows("text:The working tree has no unstaged changes.")).toBe(
		true,
	);

	// Returning to p1 restores p1's view preferences and reloads status.
	await app.press("id:switch-project");
	await app.waitFor("id:git-diff-view");
	expect(app.shows("text:view:working:unified:wrap:src/app.ts")).toBe(true);

	// Closing Git tab returns to chat.
	await app.press("id:git-tab-close");
	await app.waitUntil(() => !app.shows("id:git-tab"));
	expect(app.shows("text:Chat in Demo")).toBe(true);
});

test("handles status failure retry, missing file fallback on refresh, and diff failure retry", async () => {
	const app = await open("./git-workspace-fixture.tsx", wideDesktop);
	await app.waitFor("text:Chat in Demo");

	// Status read error displays ErrorState and recovers on Retry.
	await app.press("id:scenario-status-error");
	await app.press("id:header-open-git");
	await app.waitFor("id:git-status-error");
	expect(app.shows("text:Unable to read Git status")).toBe(true);
	expect(app.shows("text:not a git repository")).toBe(true);

	await app.press("id:scenario-normal");
	await app.press("id:git-status-retry");
	await app.waitFor("id:git-diff-view");
	expect(app.shows("id:git-diff-pane >> text:app.ts")).toBe(true);

	// Refresh where previously selected file disappears falls back to remaining file.
	await app.press("id:scenario-after-refresh");
	await app.press("id:git-refresh");
	await app.waitFor("id:git-diff-pane >> text:notes.md");
	expect(app.shows("id:git-file-count >> text:1")).toBe(true);

	// Diff error shows separate retryable ErrorState and recovers on retry.
	await app.press("id:scenario-diff-error");
	await app.press("id:git-refresh");
	await app.waitFor("id:git-diff-error");
	expect(app.shows("text:Unable to read diff")).toBe(true);
	expect(app.shows("text:git diff timed out")).toBe(true);

	await app.press("id:git-diff-retry");
	await app.waitFor("id:git-diff-view");
});

test("renders binary metadata, combined raw fallback, empty diff, and ignores stale diff completions", async () => {
	const app = await open("./git-workspace-fixture.tsx", wideDesktop);
	await app.waitFor("text:Chat in Demo");

	await app.press("id:scenario-special-diffs");
	await app.press("id:header-open-git");

	// Binary/metadata-only diff.
	await app.waitFor("id:git-diff-metadata");
	expect(
		app.shows(
			"text:This change has no text differences. Git metadata is shown below.",
		),
	).toBe(true);
	expect(
		app
			.texts()
			.some((text) =>
				text.includes(
					"Binary files a/assets/logo.png and b/assets/logo.png differ",
				),
			),
	).toBe(true);

	// Combined conflict diff falls back to inert raw text.
	await app.press("id:git-file-row:src/conflict.ts");
	await app.waitFor("id:git-diff-raw-fallback");
	expect(
		app.shows(
			"text:Highlighting is unavailable for this format. Showing the original Git diff.",
		),
	).toBe(true);

	// Truncated unified patch falls back to raw text instead of rendering blank.
	await app.press("id:git-file-row:src/truncated.ts");
	await app.waitFor("id:git-diff-raw-fallback");
	expect(
		app
			.texts()
			.some((text) => text.includes("-only one line before truncation")),
	).toBe(true);

	// Empty textual diff shows empty state.
	await app.press("id:git-file-row:empty.txt");
	await app.waitFor("id:git-diff-empty");
	expect(app.shows("text:No diff to display")).toBe(true);

	// Stale race: slow diff for src/app.ts resolves after switching to notes.md.
	await app.press("id:scenario-stale-race");
	await app.press("id:git-refresh");
	await app.waitFor("id:git-diff-skeleton");
	await app.press("id:git-file-row:notes.md");
	await app.waitFor("id:git-diff-pane >> text:notes.md");
	await app.waitFor("id:git-diff-view");
	await app.press("id:resolve-slow-diff");
	expect(app.shows("id:git-diff-pane >> text:notes.md")).toBe(true);
	expect(app.shows("text:STALE_PAYLOAD_SHOULD_NOT_SHOW")).toBe(false);
});

test("narrow viewport navigates between file list and diff detail with back button", async () => {
	const app = await open("./git-workspace-fixture.tsx", narrowDesktop);
	await app.waitFor("text:Chat in Demo");

	await app.press("id:header-open-git");
	await app.waitFor("id:git-file-row:src/app.ts");
	expect(app.shows("id:git-back-to-list")).toBe(false);

	// Selecting a file opens the detail pane with a back button.
	await app.press("id:git-file-row:src/app.ts");
	await app.waitFor("id:git-back-to-list");
	await app.waitFor("id:git-diff-view");

	// Back returns to the file list pane.
	await app.press("id:git-back-to-list");
	await app.waitFor("id:git-file-row:src/app.ts");
	expect(app.shows("id:git-back-to-list")).toBe(false);
});
