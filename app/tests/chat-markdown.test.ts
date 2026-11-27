import { TextView } from "nsh/base";
import { expect, open, test } from "nsh/test";

import {
	annotateMarkdownDocumentFileLinks,
	createMarkdownFileLinkAnnotator,
} from "@shared/chat/chat-markdown-links";
import { createStreamingMarkdownParser } from "@shared/chat/streaming-markdown-parser";

const desktop = {
	platform: "macos",
	width: 1100,
	height: 720,
	locale: "en-US",
} as const;

function openChat(scenario: string) {
	return open("./chat-markdown-fixture.tsx", {
		...desktop,
		storage: { "fixture.scenario": scenario },
	});
}

test("a reply renders its Markdown: headings, styles, lists, table, quote, code", async () => {
	const app = await openChat("reply");
	await app.waitFor("text:Reply heading");
	expect(app.shows("text:A paragraph with bold words and inline code.")).toBe(
		true,
	);
	expect(app.shows("text:name")).toBe(true);
	expect(app.shows("text:value")).toBe(true);
	expect(app.shows("text:a quote")).toBe(true);
	expect(app.shows("text:const answer: number = 42;")).toBe(true);
	expect(app.shows("text:Below the image")).toBe(true);
});

test("a reply still coming renders the Markdown it has so far", async () => {
	const app = await openChat("streaming");
	await app.waitFor("text:Reply heading");
	expect(app.shows("text:Below the image")).toBe(true);
});

test("the default body also renders Markdown", async () => {
	const app = await openChat("plain");
	await app.waitFor("text:Reply heading");
	expect(app.shows("text:const answer: number = 42;")).toBe(true);
});

test("a press on a project file link reports the resolved file URL", async () => {
	const app = await openChat("reply");
	await app.waitFor("text:Reply heading");
	await app.press("text:the project file");
	await app.waitFor("text:file:file:///work/demo/src/main.ts#10-10");
	expect(app.openedUrls()).toEqual([]);

	await app.press("text:app/plain.ts:3");
	await app.waitFor("text:file:file:///work/demo/app/plain.ts#3-3");

	await app.press("text:src/other.ts:20-25");
	await app.waitFor("text:file:file:///work/demo/src/other.ts#20-25");

	await app.press("text:src/prose.ts");
	await app.waitFor("text:file:file:///work/demo/src/prose.ts#7-7");

	await app.press("text:src/coded.ts:14");
	await app.waitFor("text:file:file:///work/demo/src/coded.ts#14-14");
});

test("a press on a web link opens it outside the app", async () => {
	const app = await openChat("reply");
	await app.waitFor("text:Reply heading");
	await app.press("text:the site");
	expect(app.openedUrls()).toEqual(["https://example.com/docs"]);
});

test("a project-relative image is read through the client and shown", async () => {
	const app = await openChat("reply");
	await app.waitFor("text:Above the image");
	await app.waitFor("text:image:read shot.png");
	expect(app.shows("text:Below the image")).toBe(true);
});

test("a project image that cannot be read shows its fallback", async () => {
	const app = await openChat("readerror");
	await app.waitFor("text:Above the image");
	await app.waitFor("text:image:failed");
	await app.waitFor("text:shot");
	expect(app.shows("text:Below the image")).toBe(true);
});

test("a code block's copy button copies the code and shows a toast", async () => {
	const app = await openChat("reply");
	await app.waitFor("text:const answer: number = 42;");
	await app.hover("text:const answer: number = 42;");
	await app.press("label:Copy code");
	expect(app.clipboard()).toContain("const answer: number = 42;");
	await app.waitFor("text:Copied");
});

test("inline code renders with a theme-adaptive pill background", async () => {
	const light = await openChat("reply");
	await light.waitFor("text:Reply heading");
	const lightCode = light.spanStyle("text:inline code");
	expect(lightCode.backgroundColor).toBeTruthy();

	const dark = await open("./chat-markdown-fixture.tsx", {
		...desktop,
		colorScheme: "dark",
		storage: { "fixture.scenario": "reply" },
	});
	await dark.waitFor("text:Reply heading");
	const darkCode = dark.spanStyle("text:inline code");
	expect(darkCode.backgroundColor).toBeTruthy();
	expect(darkCode.backgroundColor).not.toBe(lightCode.backgroundColor);
});

test("incremental streaming parser matches full TextView.parse + file link annotation and parses only the tail", () => {
	const fullMarkdown = [
		"## Streaming Architecture",
		"",
		"Check `src/main.ts:12` and plain app/chat/chat-markdown.tsx:240 for details.",
		"",
		"- first list item",
		"",
		"- second loose item with **bold** text",
		"",
		"| col | val |",
		"| --- | --- |",
		"| a | 1 |",
		"",
		"> quote line 1",
		">",
		"> quote line 2",
		"",
		"```ts",
		"export function demo(x: number) {",
		"",
		"  return x + 1;",
		"}",
		"```",
		"",
		"Final paragraph referencing `shared/chat/streaming-markdown-parser.ts`.",
		"",
	].join("\n");

	const parsedChunks: string[] = [];
	const incremental = createStreamingMarkdownParser({
		parse: (text, streaming) => {
			parsedChunks.push(text);
			return TextView.parse(text, { streaming });
		},
		createAnnotator: createMarkdownFileLinkAnnotator,
	});

	for (let end = 12; end < fullMarkdown.length; end += 19) {
		const slice = fullMarkdown.slice(0, end);
		const incDoc = incremental({
			text: slice,
			streaming: true,
			key: "reply-1",
			annotate: true,
			projectPath: "/work/demo",
		});
		const fullDoc = annotateMarkdownDocumentFileLinks(
			TextView.parse(slice, { streaming: true }),
			"/work/demo",
		);
		expect(incDoc).toEqual(fullDoc);
	}

	// Ensure the full document length is streamed and prefix blocks are cached.
	const fullStreamingInc = incremental({
		text: fullMarkdown,
		streaming: true,
		key: "reply-1",
		annotate: true,
		projectPath: "/work/demo",
	});
	expect(fullStreamingInc).toEqual(
		annotateMarkdownDocumentFileLinks(
			TextView.parse(fullMarkdown, { streaming: true }),
			"/work/demo",
		),
	);

	// Appending one more token to the active tail must only pass the tail to TextView.parse.
	parsedChunks.length = 0;
	const appended = `${fullMarkdown}More trailing words.`;
	const appendedInc = incremental({
		text: appended,
		streaming: true,
		key: "reply-1",
		annotate: true,
		projectPath: "/work/demo",
	});
	expect(appendedInc).toEqual(
		annotateMarkdownDocumentFileLinks(
			TextView.parse(appended, { streaming: true }),
			"/work/demo",
		),
	);
	expect(parsedChunks.length).toBe(1);
	expect(parsedChunks[0]?.includes("## Streaming Architecture")).toBe(false);
	expect(parsedChunks[0]!.length).toBeLessThan(appended.length / 2);

	const settledInc = incremental({
		text: appended,
		streaming: false,
		key: "reply-1",
		annotate: true,
		projectPath: "/work/demo",
	});
	const settledFull = annotateMarkdownDocumentFileLinks(
		TextView.parse(appended, { streaming: false }),
		"/work/demo",
	);
	expect(settledInc).toEqual(settledFull);
});

test("incremental streaming parser handles blockquote/list ref defs, nested details, and duplicate heading anchors", () => {
	const cases = [
		"See [docs][d].\n\nMiddle paragraph.\n\n> [d]: https://example.com\n",
		"See [docs][d].\n\nMiddle paragraph.\n\n- [d]: https://example.com\n",
		[
			"<details>",
			"<summary>Outer</summary>",
			"",
			"<details>",
			"<summary>Inner</summary>",
			"",
			"Inner body",
			"</details>",
			"",
			"Outer body",
			"</details>",
			"",
			"After nested details.",
			"",
		].join("\n"),
		"## Usage\n\nFirst section.\n\n## Usage\n\nSecond section.\n\n## Usage\n\nThird section.\n",
	];

	for (const [caseIndex, doc] of cases.entries()) {
		const incremental = createStreamingMarkdownParser({
			parse: (text, streaming) => TextView.parse(text, { streaming }),
			createAnnotator: createMarkdownFileLinkAnnotator,
		});
		for (let end = 10; end <= doc.length; end += 11) {
			const slice = doc.slice(0, end);
			expect(
				incremental({
					text: slice,
					streaming: true,
					key: `edge-${caseIndex}`,
					annotate: true,
					projectPath: "/work/demo",
				}),
			).toEqual(
				annotateMarkdownDocumentFileLinks(
					TextView.parse(slice, { streaming: true }),
					"/work/demo",
				),
			);
		}
		expect(
			incremental({
				text: doc,
				streaming: true,
				key: `edge-${caseIndex}`,
				annotate: true,
				projectPath: "/work/demo",
			}),
		).toEqual(
			annotateMarkdownDocumentFileLinks(
				TextView.parse(doc, { streaming: true }),
				"/work/demo",
			),
		);
	}
});
