import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1200, height: 800 } as const;

function openFixture() {
	return open("./file-preview-fixture.tsx", desktop);
}

test("clicking a code link opens a preview tab with line range, copies, reuses on new line, and isolates projects", async () => {
	const app = await openFixture();
	await app.waitFor("text:main lines");
	await app.press("text:main lines");

	await app.waitFor("id:file-tab:/work/demo/src/main.ts");
	await app.waitFor("id:file-preview-editor");
	expect(app.shows("text:src/main.ts")).toBe(true);
	expect(app.shows("id:file-preview-line-range >> text:L15-L18")).toBe(true);
	expect(app.shows("text:15")).toBe(true);
	expect(app.shows("text:export const line15 = 15;")).toBe(true);

	await app.press("id:file-preview-copy");
	await app.waitFor("text:Copied");
	expect(await app.clipboard()).toContain("export const line15 = 15;");

	// Switch to project p2: p1's file tabs do not leak into p2.
	await app.press("id:switch-project");
	await app.waitFor("text:Project p2");
	expect(app.shows("id:file-tab:/work/demo/src/main.ts")).toBe(false);

	// Switch back to p1, return to chat, and jump to a different line without re-fetching.
	await app.press("id:switch-project");
	await app.waitFor("id:file-tab:/work/demo/src/main.ts");
	await app.press("id:session-header");
	await app.waitFor("text:line three");
	await app.press("text:line three");
	await app.waitFor("id:file-preview-line-range >> text:L3");
	expect(app.texts().find((text) => text.startsWith("calls:"))).toBe(
		"calls:preview:file:///work/demo/src/main.ts",
	);

	// Closing the tab returns to chat.
	await app.press("id:file-tab-close:/work/demo/src/main.ts");
	await app.waitUntil(() => !app.shows("id:file-tab:/work/demo/src/main.ts"));
	expect(app.shows("text:main lines")).toBe(true);
});

test("markdown files render as Markdown by default and switch to source with line numbers on toggle or line link", async () => {
	const app = await openFixture();
	await app.waitFor("text:notes doc");
	await app.press("text:notes doc");

	await app.waitFor("id:file-preview-markdown");
	await app.waitFor("text:Release Notes");

	await app.press("id:file-preview-toggle-source");
	await app.waitFor("id:file-preview-editor");

	await app.press("id:file-preview-toggle-source");
	await app.waitFor("id:file-preview-markdown");

	// Returning to chat and clicking a line-targeted markdown link jumps into source view.
	await app.press("id:session-header");
	await app.waitFor("text:notes line");
	await app.press("text:notes line");
	await app.waitFor("id:file-preview-editor");
	expect(app.shows("id:file-preview-line-range >> text:L3")).toBe(true);
});

test("html links delegate to the system app and missing files show an error toast", async () => {
	const app = await openFixture();
	await app.waitFor("text:html report");
	await app.press("text:html report");
	await app.waitFor("text:calls:sys:file:///work/demo/report.html");
	expect(app.shows("id:file-preview-editor")).toBe(false);

	await app.press("text:missing file");
	await app.waitFor("text:ENOENT: missing.ts");
});

test("clicking tool row file paths opens text files in tabs and project images in the lightbox", async () => {
	const app = await openFixture();
	await app.waitFor("text:Work activity");
	await app.waitFor("id:chat-tool-file-link >> text:main.ts");
	await app.press("id:chat-tool-file-link >> text:main.ts");
	await app.waitFor("id:file-tab:/work/demo/src/main.ts");
	await app.waitFor("id:file-preview-editor");

	await app.press("id:session-header");
	await app.waitFor("id:chat-tool-file-link >> text:shot.png");
	await app.press("id:chat-tool-file-link >> text:shot.png");
	await app.waitFor("id:lightbox-title");
	expect(app.shows("text:shot.png")).toBe(true);
});
