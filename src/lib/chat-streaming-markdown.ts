import remend, { type RemendOptions } from "remend";
import { parseMarkdownIntoBlocks } from "streamdown";

import {
	normalizeTexMathDelimiters,
	normalizeTexMathDelimitersWithMetadata,
} from "./markdown-single-dollar-math.ts";

const LIVE_SUBSTANTIVE_BLOCKS = 2;
const FOOTNOTE_REFERENCE = /\[\^[\w-]{1,200}\](?!:)/;
const FOOTNOTE_DEFINITION = /\[\^[\w-]{1,200}\]:/;
const REFERENCE_DEFINITION = /^[ \t]{0,3}\[(?!\^)[^\]\n]{1,200}\]:/m;
const REFERENCE_USE = /!?\[[^\]\n]{1,200}\]\[(?!\^)[^\]\n]{0,200}\]/;
const FENCED_CODE_START = /^[ \t]{0,3}(`{3,}|~{3,})/;

export type StreamingMarkdownParseMetrics = {
	sourceChars: number;
	parsedChars: number;
	reusedChars: number;
	liveTailChars: number;
	stableBlocks: number;
	liveBlocks: number;
	fullParse: boolean;
	footnoteFallback: boolean;
	referenceFallback: boolean;
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

function stripInlineCodeSpans(value: string) {
	let result = "";
	let index = 0;
	while (index < value.length) {
		if (value[index] !== "`") {
			result += value[index];
			index += 1;
			continue;
		}

		let runEnd = index + 1;
		while (runEnd < value.length && value[runEnd] === "`") runEnd += 1;
		const delimiter = value.slice(index, runEnd);
		const closingIndex = value.indexOf(delimiter, runEnd);
		if (closingIndex < 0) {
			result += value.slice(index);
			break;
		}
		result += " ".repeat(closingIndex + delimiter.length - index);
		index = closingIndex + delimiter.length;
	}
	return result;
}

/**
 * Cross-block syntax detection runs on the small unfrozen tail. Ignore fenced,
 * indented and inline code so source examples such as `m[2][0]` do not promote
 * an otherwise incremental message into permanent whole-document parsing.
 */
function markdownSourceForCrossBlockScan(value: string) {
	const output: string[] = [];
	let fence: { marker: string; length: number } | null = null;

	for (const line of value.split("\n")) {
		const fenceMatch = FENCED_CODE_START.exec(line);
		if (fence) {
			if (
				fenceMatch &&
				fenceMatch[1][0] === fence.marker &&
				fenceMatch[1].length >= fence.length &&
				line.slice(fenceMatch[0].length).trim().length === 0
			) {
				fence = null;
			}
			output.push("");
			continue;
		}

		if (fenceMatch) {
			fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
			output.push("");
			continue;
		}

		if (/^(?: {4}|\t)/.test(line)) {
			output.push("");
			continue;
		}
		output.push(stripInlineCodeSpans(line));
	}

	return output.join("\n");
}

function parseCrossBlockSemanticTail(
	markdown: string,
	options?: RemendOptions,
) {
	const normalized = remend(normalizeTexMathDelimiters(markdown), options);
	return normalized.length > 0 ? [normalized] : [];
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
 * Footnotes and reference-style links/images have cross-block semantics. When
 * one appears in the live tail, stable blocks before that point stay frozen and
 * only the semantic suffix remains grouped into one live block. Code examples
 * are excluded from detection so bracket-heavy source code cannot accidentally
 * disable incremental parsing for the rest of a long answer.
 */
export function createStreamingMarkdownBlockParser(
	options: StreamingMarkdownParserOptions = {},
): (markdown: string) => string[] {
	let stableBlocks: string[] = [];
	let stableSourceLength = 0;
	let previousSource = "";
	let documentFallback = false;
	let footnoteFallback = false;
	let referenceFallback = false;
	let fallbackSourceLength = 0;

	const resetIncrementalState = () => {
		stableBlocks = [];
		stableSourceLength = 0;
		previousSource = "";
		documentFallback = false;
		footnoteFallback = false;
		referenceFallback = false;
		fallbackSourceLength = 0;
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

		let tailSource = markdown.slice(stableSourceLength);
		if (!documentFallback) {
			const scanSource = markdownSourceForCrossBlockScan(tailSource);
			footnoteFallback = hasFootnoteMarkup(scanSource);
			referenceFallback = hasCrossBlockReferenceMarkup(scanSource);
			documentFallback = footnoteFallback || referenceFallback;
			if (documentFallback) fallbackSourceLength = stableSourceLength;
		}

		if (documentFallback) {
			const fallbackTail = markdown.slice(fallbackSourceLength);
			const liveBlocks = parseCrossBlockSemanticTail(
				fallbackTail,
				options.remend,
			);
			const blocks = [...stableBlocks, ...liveBlocks];
			rememberSource(markdown);
			options.onMetrics?.({
				sourceChars: markdown.length,
				parsedChars: fallbackTail.length,
				reusedChars: fallbackSourceLength,
				liveTailChars: fallbackTail.length,
				stableBlocks: stableBlocks.length,
				liveBlocks: liveBlocks.length,
				fullParse: fallbackSourceLength === 0,
				footnoteFallback,
				referenceFallback,
				durationMs: performance.now() - startedAt,
			});
			return blocks;
		}

		const reusedChars = stableSourceLength;
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
			referenceFallback: false,
			durationMs: performance.now() - startedAt,
		});
		return blocks;
	};
}

export function parseFinalMarkdownIntoBlocks(
	markdown: string,
	options?: RemendOptions,
) {
	const scanSource = markdownSourceForCrossBlockScan(markdown);
	if (
		hasFootnoteMarkup(scanSource) ||
		hasCrossBlockReferenceMarkup(scanSource)
	) {
		return parseCrossBlockSemanticTail(markdown, options);
	}
	return parseStreamingTail(markdown, options);
}
