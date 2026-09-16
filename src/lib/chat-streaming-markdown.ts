import remend, { type RemendOptions } from "remend";
import { parseMarkdownIntoBlocks } from "streamdown";

import {
	normalizeTexMathDelimiters,
	normalizeTexMathDelimitersWithMetadata,
} from "./markdown-single-dollar-math.ts";

const CROSS_BLOCK_SCAN_OVERLAP_CHARS = 256;
const LIVE_SUBSTANTIVE_BLOCKS = 2;
const FOOTNOTE_REFERENCE = /\[\^[\w-]{1,200}\](?!:)/;
const FOOTNOTE_DEFINITION = /\[\^[\w-]{1,200}\]:/;
const REFERENCE_DEFINITION = /^[ \t]{0,3}\[(?!\^)[^\]\n]{1,200}\]:/m;
const REFERENCE_USE = /!?\[[^\]\n]{1,200}\]\[(?!\^)[^\]\n]{0,200}\]/;

export type StreamingMarkdownParseMetrics = {
	sourceChars: number;
	parsedChars: number;
	reusedChars: number;
	liveTailChars: number;
	stableBlocks: number;
	liveBlocks: number;
	fullParse: boolean;
	footnoteFallback: boolean;
	durationMs: number;
};

type StreamingMarkdownParserOptions = {
	remend?: RemendOptions;
	onMetrics?: (metrics: StreamingMarkdownParseMetrics) => void;
};

function hasFootnoteMarkup(value: string) {
	return FOOTNOTE_REFERENCE.test(value) || FOOTNOTE_DEFINITION.test(value);
}

function hasCrossBlockReferenceMarkup(value: string) {
	return REFERENCE_DEFINITION.test(value) || REFERENCE_USE.test(value);
}

function parseStreamingTail(markdown: string, options?: RemendOptions) {
	return parseMarkdownIntoBlocks(
		remend(normalizeTexMathDelimiters(markdown), options),
	);
}

function stableCutoffForTail(
	normalizedTail: string,
	pendingDelimiterIndex: number | null,
) {
	const rawBlocks = parseMarkdownIntoBlocks(normalizedTail);
	if (rawBlocks.join("") !== normalizedTail) return 0;

	let substantiveSeen = 0;
	let keepFrom = 0;
	for (let index = rawBlocks.length - 1; index >= 0; index -= 1) {
		if (!rawBlocks[index].trim()) continue;
		substantiveSeen += 1;
		if (substantiveSeen === LIVE_SUBSTANTIVE_BLOCKS) {
			keepFrom = index;
			break;
		}
	}
	if (substantiveSeen < LIVE_SUBSTANTIVE_BLOCKS) return 0;

	let cutoff = 0;
	for (let index = 0; index < keepFrom; index += 1) {
		cutoff += rawBlocks[index].length;
	}
	if (cutoff === 0) return 0;

	if (pendingDelimiterIndex !== null && cutoff > pendingDelimiterIndex) {
		let safeCutoff = 0;
		for (const block of rawBlocks) {
			const next = safeCutoff + block.length;
			if (next > pendingDelimiterIndex) break;
			safeCutoff = next;
		}
		cutoff = safeCutoff;
	}
	return cutoff;
}

/**
 * Streamdown's default streaming path runs `remend` and Marked's lexer over the
 * complete accumulated message on every render. This parser freezes settled
 * top-level blocks and only normalizes / repairs / lexes a small live suffix.
 *
 * We deliberately retain the two newest substantive blocks. Markdown constructs
 * such as a list can absorb later indented content even after a trailing newline;
 * retaining one complete predecessor prevents us from freezing that block before
 * the following top-level block proves the boundary stable. Open fenced code,
 * HTML and `$$` math are already kept together by Streamdown's block splitter.
 *
 * Pilo's `\\(`/`\\[` preprocessing can also change earlier source once its closing
 * delimiter arrives, so an unterminated TeX opener is a hard freeze boundary.
 * Footnotes and reference-style links/images have whole-document semantics in
 * Streamdown; when one appears we intentionally fall back to the exact
 * full-document path for that message.
 */
export function createStreamingMarkdownBlockParser(
	options: StreamingMarkdownParserOptions = {},
): (markdown: string) => string[] {
	let stableBlocks: string[] = [];
	let stableSourceLength = 0;
	let previousSource = "";
	let documentFallback = false;
	let footnoteFallback = false;

	const resetIncrementalState = () => {
		stableBlocks = [];
		stableSourceLength = 0;
		previousSource = "";
		documentFallback = false;
		footnoteFallback = false;
	};

	const rememberSource = (source: string) => {
		previousSource = source;
	};

	return (markdown: string) => {
		const startedAt = performance.now();
		const previousSourceLength = previousSource.length;
		const canContinue =
			previousSourceLength === 0 || markdown.startsWith(previousSource);
		if (!canContinue) resetIncrementalState();

		if (!documentFallback) {
			const scanStart = canContinue
				? Math.max(0, previousSourceLength - CROSS_BLOCK_SCAN_OVERLAP_CHARS)
				: 0;
			const scanSource = markdown.slice(scanStart);
			footnoteFallback = hasFootnoteMarkup(scanSource);
			documentFallback =
				footnoteFallback || hasCrossBlockReferenceMarkup(scanSource);
		}

		if (documentFallback) {
			const blocks = parseStreamingTail(markdown, options.remend);
			stableBlocks = [];
			stableSourceLength = 0;
			rememberSource(markdown);
			options.onMetrics?.({
				sourceChars: markdown.length,
				parsedChars: markdown.length,
				reusedChars: 0,
				liveTailChars: markdown.length,
				stableBlocks: 0,
				liveBlocks: blocks.length,
				fullParse: true,
				footnoteFallback,
				durationMs: performance.now() - startedAt,
			});
			return blocks;
		}

		const reusedChars = stableSourceLength;
		let tailSource = markdown.slice(stableSourceLength);
		const normalizedTail = normalizeTexMathDelimitersWithMetadata(tailSource);
		const cutoff = stableCutoffForTail(
			normalizedTail.text,
			normalizedTail.pendingDelimiterIndex,
		);

		if (cutoff > 0) {
			const newlyStableSource = tailSource.slice(0, cutoff);
			stableBlocks.push(
				...parseStreamingTail(newlyStableSource, options.remend),
			);
			stableSourceLength += cutoff;
			tailSource = markdown.slice(stableSourceLength);
		}

		const liveBlocks = parseStreamingTail(tailSource, options.remend);
		const blocks = [...stableBlocks, ...liveBlocks];
		rememberSource(markdown);
		options.onMetrics?.({
			sourceChars: markdown.length,
			parsedChars: markdown.length - reusedChars,
			reusedChars,
			liveTailChars: tailSource.length,
			stableBlocks: stableBlocks.length,
			liveBlocks: liveBlocks.length,
			fullParse: reusedChars === 0,
			footnoteFallback: false,
			durationMs: performance.now() - startedAt,
		});
		return blocks;
	};
}

export function parseFinalMarkdownIntoBlocks(
	markdown: string,
	options?: RemendOptions,
) {
	return parseStreamingTail(markdown, options);
}
