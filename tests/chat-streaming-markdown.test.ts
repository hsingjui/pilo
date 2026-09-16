import assert from "node:assert/strict";
import test from "node:test";

import {
	createStreamingMarkdownBlockParser,
	parseFinalMarkdownIntoBlocks,
	type StreamingMarkdownParseMetrics,
} from "../src/lib/chat-streaming-markdown.ts";

const FIXTURES = [
	{
		name: "paragraphs and inline markup",
		markdown:
			"# 标题\n\n第一段 **粗体** 和 [链接](https://example.com)。\n\n第二段包含 `inline code` 与 *强调*。\n\n结束。\n",
	},
	{
		name: "gfm table and list",
		markdown:
			"| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n- item one\n- item two\n  - nested\n\n结束。\n",
	},
	{
		name: "open and closed fenced code",
		markdown:
			"开始。\n\n```ts\nconst x = 1;\nconst y = `value ${x}`;\n```\n\n代码之后。\n",
	},
	{
		name: "nested fenced code",
		markdown:
			"> 引用\n>\n> - item\n>   ```ts\n>   const x = 1;\n>   ```\n\n结束。\n",
	},
	{
		name: "tex delimiters across blocks",
		markdown:
			"公式之前。\n\n\\[\na + b\n\n= c + d\n\\]\n\n内联 \\(x + y\\) 完成。\n\n结束。\n",
	},
	{
		name: "dollar math",
		markdown:
			"开始。\n\n$$\na+b\\\\\nc+d\n$$\n\n单美元 $x+y$ 后继续。\n\n结束。\n",
	},
	{
		name: "html block",
		markdown:
			"之前。\n\n<div>\n  <strong>hello</strong>\n\n  <span>world</span>\n</div>\n\n之后。\n",
	},
	{
		name: "footnote whole-document fallback",
		markdown: "引用脚注[^note]。\n\n中间正文。\n\n[^note]: 脚注内容。\n",
	},
	{
		name: "reference link whole-document fallback",
		markdown:
			"先引用 [Pilo][project]。\n\n中间正文保持独立。\n\n[project]: https://example.com/pilo\n",
	},
	{
		name: "reference image whole-document fallback",
		markdown:
			"图片 ![架构图][diagram]。\n\n中间正文。\n\n[diagram]: https://example.com/diagram.png\n",
	},
] as const;

function assertIncrementalMatchesFull(markdown: string) {
	const parser = createStreamingMarkdownBlockParser();
	const step = Math.max(1, Math.floor(markdown.length / 17));
	for (let end = 1; end < markdown.length; end += step) {
		const prefix = markdown.slice(0, end);
		assert.deepEqual(parser(prefix), parseFinalMarkdownIntoBlocks(prefix));
	}
	assert.deepEqual(parser(markdown), parseFinalMarkdownIntoBlocks(markdown));
}

for (const fixture of FIXTURES) {
	test(`incremental markdown matches full parser: ${fixture.name}`, () => {
		assertIncrementalMatchesFull(fixture.markdown);
	});
}

test("incremental parser resets safely when source is replaced", () => {
	const parser = createStreamingMarkdownBlockParser();
	const first = "第一段。\n\n第二段。\n\n第三段。\n";
	parser(first);

	const replacement = "完全不同的开头。\n\n```rust\nfn main() {}\n```\n";
	assert.deepEqual(
		parser(replacement),
		parseFinalMarkdownIntoBlocks(replacement),
	);
});

test("streaming parser keeps parse work bounded to the live tail", () => {
	let latest: StreamingMarkdownParseMetrics | null = null;
	const parser = createStreamingMarkdownBlockParser({
		onMetrics: (metrics) => {
			latest = metrics;
		},
	});
	let source = "";
	for (let index = 0; index < 800; index += 1) {
		source += `## Section ${index}\n\n这是第 ${index} 段稳定正文，包含 **粗体**、链接和足够多的字符用于模拟长回复。\n\n`;
		parser(source);
	}

	assert.ok(source.length > 30_000);
	assert.ok(latest);
	const metrics = latest as StreamingMarkdownParseMetrics;
	assert.ok(metrics.reusedChars > source.length * 0.95);
	assert.ok(metrics.parsedChars < 1_000);
	assert.ok(metrics.liveTailChars < 1_000);
	assert.equal(metrics.footnoteFallback, false);
});

test("footnotes deliberately use full-document parsing", () => {
	let latest: StreamingMarkdownParseMetrics | null = null;
	const parser = createStreamingMarkdownBlockParser({
		onMetrics: (metrics) => {
			latest = metrics;
		},
	});
	const source = "正文[^a]。\n\n另一段。\n\n[^a]: 注释。\n";
	assert.deepEqual(parser(source), parseFinalMarkdownIntoBlocks(source));
	assert.ok(latest);
	const metrics = latest as StreamingMarkdownParseMetrics;
	assert.equal(metrics.footnoteFallback, true);
	assert.equal(metrics.parsedChars, source.length);
});

test("reference links use full-document parsing without footnote metrics", () => {
	let latest: StreamingMarkdownParseMetrics | null = null;
	const parser = createStreamingMarkdownBlockParser({
		onMetrics: (metrics) => {
			latest = metrics;
		},
	});
	const source =
		"正文 [Pilo][project]。\n\n另一段。\n\n[project]: https://example.com/pilo\n";
	assert.deepEqual(parser(source), parseFinalMarkdownIntoBlocks(source));
	assert.ok(latest);
	const metrics = latest as StreamingMarkdownParseMetrics;
	assert.equal(metrics.fullParse, true);
	assert.equal(metrics.footnoteFallback, false);
	assert.equal(metrics.parsedChars, source.length);
});
