import assert from "node:assert/strict";
import test from "node:test";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { highlightProjectFile } from "../../src/lib/code-highlighter.ts";
import { normalizeTexMathDelimiters } from "../../src/lib/markdown-single-dollar-math.ts";
import { rehypeMarkdownSourceLines } from "../../src/lib/markdown-source-lines.ts";

type SourceNode = Parameters<ReturnType<typeof rehypeMarkdownSourceLines>>[0];
const processor = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkRehype, { allowDangerousHtml: true })
	.use(rehypeRaw)
	.use(rehypeSanitize)
	.use(rehypeMarkdownSourceLines);

function sourceNodes(markdown: string) {
	const source = normalizeTexMathDelimiters(markdown);
	const tree = processor.runSync(processor.parse(source));
	const nodes: SourceNode[] = [];
	const visit = (node: SourceNode) => {
		if (node.properties?.["data-source-line-start"] !== undefined)
			nodes.push(node);
		for (const child of node.children ?? []) visit(child);
	};
	visit(tree);
	return nodes;
}

const documentLines = [
	"# Title",
	"",
	"First paragraph",
	"continued",
	"",
	"- List item",
	"  continuation",
	"",
	"| A | B |",
	"| - | - |",
	"| 1 | 2 |",
	"",
	"```ts",
	"const value = 1;",
	"```",
	"",
	"\\[",
	"x = 1",
	"\\]",
	"",
	"Last paragraph",
];

for (const newline of ["\n", "\r\n", "\r"]) {
	test(`Markdown blocks retain global source lines with ${JSON.stringify(newline)}`, () => {
		const nodes = sourceNodes(documentLines.join(newline));
		const hasRange = (tag: string, start: number, end: number) =>
			nodes.some(
				(node) =>
					node.tagName === tag &&
					node.properties?.["data-source-line-start"] === start &&
					node.properties?.["data-source-line-end"] === end,
			);
		assert.ok(hasRange("h1", 1, 1));
		assert.ok(hasRange("p", 3, 4));
		assert.ok(hasRange("li", 6, 7));
		assert.ok(hasRange("table", 9, 11));
		assert.ok(hasRange("th", 9, 9));
		assert.ok(hasRange("td", 11, 11));
		assert.ok(
			hasRange("p", 21, 21),
			"TeX normalization must not shift later lines",
		);
		const fence = nodes.find((node) => node.tagName === "div");
		assert.deepEqual(fence?.properties, {
			"data-source-line-start": 13,
			"data-source-line-end": 15,
		});
		assert.equal(fence?.children?.[0].tagName, "pre");
		assert.equal(fence?.children?.[0].children?.[0].tagName, "code");
		assert.ok(
			!nodes.some((node) => node.tagName === "pre"),
			"Only the surviving fence wrapper is annotated",
		);
	});
}

test("raw HTML cannot spoof preview source positions", () => {
	const nodes = sourceNodes(
		'<p data-source-line-start="999" data-source-line-end="1000">Actual</p>',
	);
	assert.equal(nodes.length, 1);
	assert.deepEqual(nodes[0].properties, {
		"data-source-line-start": 1,
		"data-source-line-end": 1,
	});
});

test("Shiki preview lines carry source locations and retain bounded fallbacks", async () => {
	const html = await highlightProjectFile(
		"main.ts",
		"const first = 1;\nconst second = 2;\n",
	);
	assert.ok(html);
	assert.deepEqual(
		[...html.matchAll(/data-source-line-start="(\d+)"/g)].map((match) =>
			Number(match[1]),
		),
		[1, 2, 3],
	);
	assert.deepEqual(
		[...html.matchAll(/data-source-line-end="(\d+)"/g)].map((match) =>
			Number(match[1]),
		),
		[1, 2, 3],
	);
	assert.equal(await highlightProjectFile("notes.txt", "plain text"), null);
	assert.equal(
		await highlightProjectFile("large.ts", "x".repeat(200_001)),
		null,
	);
});
