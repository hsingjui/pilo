import { expect, open, test } from "nsh/test";

const desktop = {
	platform: "macos",
	width: 1200,
	height: 800,
	locale: "en-US",
} as const;

function openFixture() {
	return open("./file-preview-fixture.tsx", desktop);
}

test("clicking a code link opens a preview tab at the target line, reuses on new line, and isolates projects", async () => {
	const app = await openFixture();
	await app.waitFor("text:main lines");
	await app.press("text:main lines");

	await app.waitFor("id:file-tab:/work/demo/src/main.ts");
	await app.waitFor("id:file-preview-editor");
	expect(app.shows("id:file-preview-path")).toBe(false);
	expect(app.shows("id:file-preview-copy")).toBe(false);
	expect(app.shows("text:15")).toBe(true);
	expect(app.shows("text:export const line15 = 15;")).toBe(true);

	// Switch to project p2: p1's file tabs do not leak into p2.
	await app.press("id:switch-project");
	await app.waitFor("text:Project p2");
	expect(app.shows("id:file-tab:/work/demo/src/main.ts")).toBe(false);

	// Switch back to p1, return to chat, and jump to a different line while refreshing disk content.
	await app.press("id:switch-project");
	await app.waitFor("id:file-tab:/work/demo/src/main.ts");
	await app.press("id:session-header");
	await app.waitFor("text:line three");
	await app.press("text:line three");
	await app.waitFor("text:export const line3 = 3;");
	expect(app.texts().find((text) => text.startsWith("calls:"))).toBe(
		"calls:preview:file:///work/demo/src/main.ts|preview:file:///work/demo/src/main.ts",
	);

	// Closing the tab returns to chat.
	await app.press("id:file-tab-close:/work/demo/src/main.ts");
	await app.waitUntil(() => !app.shows("id:file-tab:/work/demo/src/main.ts"));
	expect(app.shows("text:main lines")).toBe(true);
});

test("markdown files render as Markdown by default and switch to source with line numbers on line link", async () => {
	const app = await openFixture();
	await app.waitFor("text:notes doc");
	await app.press("text:notes doc");

	await app.waitFor("id:file-preview-markdown");
	await app.waitFor("text:Release Notes");

	// Returning to chat and clicking a line-targeted markdown link jumps into source view.
	await app.press("id:session-header");
	await app.waitFor("text:notes line");
	await app.press("text:notes line");
	await app.waitFor("id:file-preview-editor");
	await app.waitFor("text:Line three detail with ![diagram](./shot.png).");

	// Clicking a plain markdown link returns to rendered Markdown view.
	await app.press("id:session-header");
	await app.waitFor("text:notes doc");
	await app.press("text:notes doc");
	await app.waitFor("id:file-preview-markdown");

	// Switching to source manually persists across tab switches until an explicit link navigation.
	await app.press("id:file-preview-toggle-source");
	await app.waitFor("id:file-preview-editor");
	await app.press("id:session-header");
	await app.press("id:file-tab:/work/demo/docs/notes.md >> text:notes.md");
	await app.waitFor("id:file-preview-editor");
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

test("clicking inline code, plain text, and thinking file references opens and jumps to the target line", async () => {
	const app = await openFixture();
	await app.waitFor("text:src/main.ts:88-90");
	await app.press("text:src/main.ts:88-90");

	await app.waitFor("id:file-tab:/work/demo/src/main.ts");
	await app.waitFor("id:file-preview-editor");
	await app.waitFor("text:export const line88 = 88;");

	await app.press("id:session-header");
	await app.waitFor("text:src/main.ts:105");
	await app.press("text:src/main.ts:105");
	await app.waitFor("text:export const line105 = 105;");

	await app.press("id:session-header");
	await app.waitFor("id:chat-thinking");
	await app.press("id:chat-thinking");
	await app.waitFor("text:src/main.ts:95");
	await app.press("text:src/main.ts:95");
	await app.waitFor("text:export const line95 = 95;");
});
