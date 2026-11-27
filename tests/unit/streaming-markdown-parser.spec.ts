import assert from "node:assert/strict";
import test from "node:test";

import {
	createStreamingMarkdownParser,
	findStableMarkdownSplit,
	type StreamingMarkdownDocumentLike,
} from "../../shared/chat/streaming-markdown-parser.ts";

type MockBlock = {
	type: "paragraph";
	content: [{ type: "text"; text: string }];
};
type MockDoc = StreamingMarkdownDocumentLike & {
	blocks: MockBlock[];
	footnotes?: { label: string; index: number; children: MockBlock[] }[];
};

function mockParse(text: string): MockDoc {
	const chunks = text
		.trim()
		.split(/\n{2,}/)
		.filter((part) => part.length > 0);
	return {
		blocks: chunks.map((chunk) => ({
			type: "paragraph",
			content: [{ type: "text", text: chunk }],
		})),
	};
}

test("findStableMarkdownSplit advances at blank lines before a complete top-level block", () => {
	const text = "# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n";
	const split = findStableMarkdownSplit(text);
	assert.equal(split.fallbackToFull, false);
	assert.equal(text.slice(split.splitOffset), "Second paragraph.\n");
});

test("findStableMarkdownSplit does not split on an incomplete trailing line", () => {
	const text = "First paragraph.\n\nSecond";
	const split = findStableMarkdownSplit(text);
	assert.equal(split.fallbackToFull, false);
	assert.equal(split.splitOffset, 0);
});

test("findStableMarkdownSplit keeps fenced code blocks, math blocks, and HTML containers intact", () => {
	const openFence = "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n";
	assert.equal(
		openFence.slice(findStableMarkdownSplit(openFence).splitOffset),
		"```ts\nconst a = 1;\n\nconst b = 2;\n",
	);

	const closedFence =
		"Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter fence.\n";
	assert.equal(
		closedFence.slice(findStableMarkdownSplit(closedFence).splitOffset),
		"After fence.\n",
	);

	const openMath = "Intro\n\n$$\nx = 1\n\ny = 2\n";
	assert.equal(
		openMath.slice(findStableMarkdownSplit(openMath).splitOffset),
		"$$\nx = 1\n\ny = 2\n",
	);

	const openDetails = "Intro\n\n<details>\n<summary>More</summary>\n\nBody\n";
	assert.equal(
		openDetails.slice(findStableMarkdownSplit(openDetails).splitOffset),
		"<details>\n<summary>More</summary>\n\nBody\n",
	);

	const closedDetails =
		"Intro\n\n<details>\n<summary>More</summary>\n\nBody\n</details>\n\nNext.\n";
	assert.equal(
		closedDetails.slice(findStableMarkdownSplit(closedDetails).splitOffset),
		"Next.\n",
	);

	const nestedDetailsOpen =
		"Intro\n\n<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nInner\n</details>\n\nOuter body\n";
	assert.equal(
		nestedDetailsOpen.slice(
			findStableMarkdownSplit(nestedDetailsOpen).splitOffset,
		),
		"<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nInner\n</details>\n\nOuter body\n",
	);

	const nestedDetailsClosed = `${nestedDetailsOpen}</details>\n\nAfter nested.\n`;
	assert.equal(
		nestedDetailsClosed.slice(
			findStableMarkdownSplit(nestedDetailsClosed).splitOffset,
		),
		"After nested.\n",
	);

	const detailsWithCodeClose =
		"Intro\n\n<details>\n<summary>Code</summary>\n\n```html\n</details>\n```\n\nStill inside\n";
	assert.equal(
		detailsWithCodeClose.slice(
			findStableMarkdownSplit(detailsWithCodeClose).splitOffset,
		),
		"<details>\n<summary>Code</summary>\n\n```html\n</details>\n```\n\nStill inside\n",
	);
});

test("findStableMarkdownSplit does not split inside loose lists, blockquotes, or indented continuations", () => {
	const looseList = "- first\n\n- second\n";
	assert.equal(findStableMarkdownSplit(looseList).splitOffset, 0);

	const indentedContinuation = "- first\n\n  continued\n";
	assert.equal(findStableMarkdownSplit(indentedContinuation).splitOffset, 0);

	const quote = "> first\n\n> second\n";
	assert.equal(findStableMarkdownSplit(quote).splitOffset, 0);

	const afterList = "- first\n\n- second\n\nDone.\n";
	assert.equal(
		afterList.slice(findStableMarkdownSplit(afterList).splitOffset),
		"Done.\n",
	);
});

test("findStableMarkdownSplit respects Setext headings without blank lines and splits thematic breaks after blank lines", () => {
	const setext = "Heading\n---\n";
	assert.equal(findStableMarkdownSplit(setext).splitOffset, 0);

	const thematic = "Paragraph\n\n---\n";
	assert.equal(
		thematic.slice(findStableMarkdownSplit(thematic).splitOffset),
		"---\n",
	);
});

test("findStableMarkdownSplit falls back to full parse for footnotes and reference link definitions", () => {
	assert.equal(
		findStableMarkdownSplit("Hello[^1]\n\nNext.\n").fallbackToFull,
		true,
	);
	assert.equal(
		findStableMarkdownSplit("See [docs][d].\n\n[d]: https://example.com\n")
			.fallbackToFull,
		true,
	);
	assert.equal(
		findStableMarkdownSplit(
			"See [docs][d].\n\nMiddle.\n\n> [d]: https://example.com\n",
		).fallbackToFull,
		true,
	);
	assert.equal(
		findStableMarkdownSplit(
			"See [docs][d].\n\nMiddle.\n\n- [d]: https://example.com\n",
		).fallbackToFull,
		true,
	);
	assert.equal(
		findStableMarkdownSplit(
			"See [docs][d].\n\n<details>\n<summary>Refs</summary>\n\n[d]: https://example.com\n</details>\n",
		).fallbackToFull,
		true,
	);
});

test("createStreamingMarkdownParser reuses stable prefix blocks and only parses the active tail", () => {
	const parsedInputs: { text: string; streaming: boolean }[] = [];
	const parser = createStreamingMarkdownParser<MockDoc>({
		parse: (text, streaming) => {
			parsedInputs.push({ text, streaming });
			return mockParse(text);
		},
	});

	const s1 = "Block 1\n\nBlock 2\n\nTail start";
	const doc1 = parser({
		text: s1,
		streaming: true,
		key: "m1",
		annotate: false,
	});
	assert.equal(doc1.blocks.length, 3);
	const firstStableBlock = doc1.blocks[0];

	parsedInputs.length = 0;
	const s2 = `${s1} more words`;
	const doc2 = parser({
		text: s2,
		streaming: true,
		key: "m1",
		annotate: false,
	});
	assert.equal(doc2.blocks[0], firstStableBlock);
	assert.deepEqual(parsedInputs, [
		{ text: "Block 2\n\nTail start more words", streaming: true },
	]);

	// Completing Block 2's successor advances the stable prefix incrementally.
	parsedInputs.length = 0;
	const s3 = `${s2}\n\nBlock 4\n`;
	const doc3 = parser({
		text: s3,
		streaming: true,
		key: "m1",
		annotate: false,
	});
	assert.equal(doc3.blocks[0], firstStableBlock);
	assert.equal(doc3.blocks.length, 4);
	assert.equal(
		parsedInputs.every((call) => call.text.length < s3.length),
		true,
	);

	// Settling performs one final full parse and caches subsequent identical reads.
	parsedInputs.length = 0;
	const settled = parser({
		text: s3,
		streaming: false,
		key: "m1",
		annotate: false,
	});
	assert.deepEqual(parsedInputs, [{ text: s3, streaming: false }]);

	parsedInputs.length = 0;
	const cached = parser({
		text: s3,
		streaming: false,
		key: "m1",
		annotate: false,
	});
	assert.equal(cached, settled);
	assert.deepEqual(parsedInputs, []);
});

test("createStreamingMarkdownParser falls back to full parse when a late reference link definition arrives", () => {
	const parsedInputs: { text: string; streaming: boolean }[] = [];
	const parser = createStreamingMarkdownParser<MockDoc>({
		parse: (text, streaming) => {
			parsedInputs.push({ text, streaming });
			return mockParse(text);
		},
	});

	const prefix = "See [guide][g].\n\nMiddle paragraph.\n\n";
	parser({
		text: `${prefix}Waiting`,
		streaming: true,
		key: "ref",
		annotate: false,
	});

	parsedInputs.length = 0;
	const full = `${prefix}[g]: https://example.com\n`;
	parser({
		text: full,
		streaming: true,
		key: "ref",
		annotate: false,
	});
	assert.deepEqual(parsedInputs, [{ text: full, streaming: true }]);
});

test("createStreamingMarkdownParser resets state when text shrinks or key changes", () => {
	const parser = createStreamingMarkdownParser<MockDoc>({
		parse: (text) => mockParse(text),
	});

	const first = parser({
		text: "A\n\nB\n\nC",
		streaming: true,
		key: "row-1",
		annotate: false,
	});
	const resetByKey = parser({
		text: "X\n\nY",
		streaming: true,
		key: "row-2",
		annotate: false,
	});
	assert.notEqual(resetByKey.blocks[0], first.blocks[0]);
	assert.deepEqual(
		resetByKey.blocks.map((block) => block.content[0].text),
		["X", "Y"],
	);

	const resetByShrink = parser({
		text: "X",
		streaming: true,
		key: "row-2",
		annotate: false,
	});
	assert.deepEqual(
		resetByShrink.blocks.map((block) => block.content[0].text),
		["X"],
	);
});
