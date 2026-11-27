import {
	annotateMarkdownDocumentFileLinks,
	createMarkdownFileLinkAnnotator,
} from "./chat-markdown-links.ts";

export interface StreamingMarkdownDocumentLike {
	readonly blocks: readonly unknown[];
	readonly footnotes?: readonly unknown[];
}

export interface StreamingMarkdownSplitResult {
	/** Byte/code-unit offset of the safe top-level block boundary (`0` means no split). */
	splitOffset: number;
	/**
	 * True when cross-block Markdown syntax (footnotes or reference link definitions)
	 * is detected, requiring a full-document parse for exact semantics.
	 */
	fallbackToFull: boolean;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const MATH_FENCE_RE = /^ {0,3}\$\$[ \t]*$/;
const CONTAINER_PREFIX_RE =
	/^(?:[ \t]*>[ \t]?|[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+|[ \t]+)/;
const REF_LINK_DEF_RE = /^\[[^\]\n]+\]:/;
const LIST_OR_QUOTE_OR_TABLE_RE = /^(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>|\|)/;
const HTML_BLOCK_OPEN_RE =
	/^ {0,3}<(details|pre|script|style|table|div|section|article|blockquote)(?=[\s>/]|$)/i;

function isFenceClose(line: string, char: "`" | "~", len: number): boolean {
	let i = 0;
	while (i < line.length && i < 3 && line.charCodeAt(i) === 32) i += 1;
	let count = 0;
	const target = char.charCodeAt(0);
	while (i < line.length && line.charCodeAt(i) === target) {
		count += 1;
		i += 1;
	}
	if (count < len) return false;
	while (i < line.length) {
		const code = line.charCodeAt(i);
		if (code !== 32 && code !== 9) return false;
		i += 1;
	}
	return true;
}

function isBlankLine(line: string): boolean {
	for (let i = 0; i < line.length; i += 1) {
		const code = line.charCodeAt(i);
		if (code !== 32 && code !== 9) return false;
	}
	return true;
}

function hasFootnoteSyntax(line: string): boolean {
	return line.includes("[^");
}

/**
 * CommonMark allows reference link definitions inside blockquotes and list items,
 * and they resolve references anywhere in the document. Strip leading container
 * markers before testing for `[label]:`.
 */
function hasReferenceLinkDefinition(line: string): boolean {
	let rest = line;
	while (rest.length > 0) {
		if (REF_LINK_DEF_RE.test(rest)) return true;
		const match = CONTAINER_PREFIX_RE.exec(rest);
		if (!match || match[0].length === 0) break;
		rest = rest.slice(match[0].length);
	}
	return false;
}

/** Counts net nesting delta (`<tag...>` opens minus `</tag>` closes) for one HTML tag on a line. */
function htmlTagDepthDelta(line: string, tag: string): number {
	const lower = line.toLowerCase();
	const openToken = `<${tag}`;
	const closeToken = `</${tag}`;
	let delta = 0;

	let pos = 0;
	while ((pos = lower.indexOf(openToken, pos)) !== -1) {
		const after = lower.charCodeAt(pos + openToken.length);
		// Tag name boundary: whitespace, `>`, `/`, or end-of-line.
		if (
			Number.isNaN(after) ||
			after === 32 ||
			after === 9 ||
			after === 62 ||
			after === 47
		) {
			// Skip self-closing `<tag .../>`.
			const closeBracket = lower.indexOf(">", pos + openToken.length);
			const selfClosing =
				closeBracket > pos && lower.charCodeAt(closeBracket - 1) === 47;
			if (!selfClosing) delta += 1;
		}
		pos += openToken.length;
	}

	pos = 0;
	while ((pos = lower.indexOf(closeToken, pos)) !== -1) {
		const after = lower.charCodeAt(pos + closeToken.length);
		if (Number.isNaN(after) || after === 32 || after === 9 || after === 62) {
			delta -= 1;
		}
		pos += closeToken.length;
	}

	return delta;
}

function collectHeadingAnchors(blocks: readonly unknown[], out: string[]) {
	for (const item of blocks) {
		if (!item || typeof item !== "object") continue;
		const block = item as Record<string, unknown>;
		if (block.type === "heading" && typeof block.anchor === "string") {
			out.push(block.anchor);
		}
		if (Array.isArray(block.children)) {
			collectHeadingAnchors(block.children, out);
		}
		if (Array.isArray(block.items)) {
			for (const listItem of block.items) {
				if (
					listItem &&
					typeof listItem === "object" &&
					Array.isArray((listItem as Record<string, unknown>).children)
				) {
					collectHeadingAnchors(
						(listItem as { children: readonly unknown[] }).children,
						out,
					);
				}
			}
		}
	}
}

/**
 * Finds the furthest top-level boundary in `text` (starting from a previously
 * validated clean top-level offset `fromOffset`) where preceding blocks are
 * completely closed and unaffected by subsequent streaming appends.
 */
export function findStableMarkdownSplit(
	text: string,
	fromOffset = 0,
): StreamingMarkdownSplitResult {
	let splitOffset = fromOffset;
	let fence: { char: "`" | "~"; len: number } | null = null;
	let inMath = false;
	let inHtmlComment = false;
	let htmlBlockTag: string | null = null;
	let htmlBlockDepth = 0;
	let sawNonBlank = false;
	let sawBlankLine = false;

	let cursor = fromOffset;
	const total = text.length;

	while (cursor < total) {
		const newlineIndex = text.indexOf("\n", cursor);
		const isCompleteLine = newlineIndex !== -1;
		let lineEnd = isCompleteLine ? newlineIndex : total;
		if (lineEnd > cursor && text.charCodeAt(lineEnd - 1) === 13) {
			lineEnd -= 1;
		}
		const line = text.slice(cursor, lineEnd);

		if (fence) {
			if (isCompleteLine && isFenceClose(line, fence.char, fence.len)) {
				fence = null;
			}
			sawBlankLine = false;
			sawNonBlank = true;
			if (!isCompleteLine) break;
			cursor = newlineIndex + 1;
			continue;
		}

		if (inMath) {
			if (isCompleteLine && MATH_FENCE_RE.test(line)) {
				inMath = false;
			}
			sawBlankLine = false;
			sawNonBlank = true;
			if (!isCompleteLine) break;
			cursor = newlineIndex + 1;
			continue;
		}

		if (inHtmlComment) {
			if (line.includes("-->")) {
				inHtmlComment = false;
			}
			sawBlankLine = false;
			sawNonBlank = true;
			if (!isCompleteLine) break;
			cursor = newlineIndex + 1;
			continue;
		}

		if (htmlBlockTag) {
			const nestedFence = FENCE_OPEN_RE.exec(line);
			if (nestedFence) {
				const marker = nestedFence[1];
				const info = nestedFence[2] ?? "";
				const char = marker[0] as "`" | "~";
				if (char === "~" || !info.includes("`")) {
					fence = { char, len: marker.length };
					sawBlankLine = false;
					sawNonBlank = true;
					if (!isCompleteLine) break;
					cursor = newlineIndex + 1;
					continue;
				}
			}
			// Still check cross-block reference/footnote syntax inside Markdown-capable
			// containers like `<details>`.
			if (hasFootnoteSyntax(line) || hasReferenceLinkDefinition(line)) {
				return { splitOffset: 0, fallbackToFull: true };
			}
			htmlBlockDepth += htmlTagDepthDelta(line, htmlBlockTag);
			if (htmlBlockDepth <= 0) {
				htmlBlockTag = null;
				htmlBlockDepth = 0;
			}
			sawBlankLine = false;
			sawNonBlank = true;
			if (!isCompleteLine) break;
			cursor = newlineIndex + 1;
			continue;
		}

		// Outside code/math/HTML comment blocks, detect cross-block references immediately.
		if (hasFootnoteSyntax(line) || hasReferenceLinkDefinition(line)) {
			return { splitOffset: 0, fallbackToFull: true };
		}

		if (isBlankLine(line)) {
			if (sawNonBlank) sawBlankLine = true;
			if (!isCompleteLine) break;
			cursor = newlineIndex + 1;
			continue;
		}

		// Only advance splitOffset when a complete non-blank line begins a fresh
		// unindented top-level block after a blank line.
		if (
			isCompleteLine &&
			sawBlankLine &&
			line.charCodeAt(0) !== 32 &&
			line.charCodeAt(0) !== 9 &&
			!LIST_OR_QUOTE_OR_TABLE_RE.test(line)
		) {
			splitOffset = cursor;
		}

		sawBlankLine = false;
		sawNonBlank = true;

		const fenceMatch = FENCE_OPEN_RE.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			const info = fenceMatch[2] ?? "";
			const char = marker[0] as "`" | "~";
			// CommonMark: backtick info strings cannot contain backticks.
			if (char === "~" || !info.includes("`")) {
				fence = { char, len: marker.length };
			}
		} else if (MATH_FENCE_RE.test(line)) {
			inMath = true;
		} else if (line.includes("<!--") && !line.includes("-->")) {
			inHtmlComment = true;
		} else {
			const htmlMatch = HTML_BLOCK_OPEN_RE.exec(line);
			if (htmlMatch) {
				const tag = htmlMatch[1].toLowerCase();
				const depth = htmlTagDepthDelta(line, tag);
				if (depth > 0) {
					htmlBlockTag = tag;
					htmlBlockDepth = depth;
				}
			}
		}

		if (!isCompleteLine) break;
		cursor = newlineIndex + 1;
	}

	return { splitOffset, fallbackToFull: false };
}

export interface StreamingMarkdownParserOptions<
	TDoc extends StreamingMarkdownDocumentLike,
> {
	parse: (text: string, streaming: boolean) => TDoc;
	annotateDocument?: (document: TDoc, projectPath?: string) => TDoc;
	createAnnotator?: () => (document: TDoc, projectPath?: string) => TDoc;
}

export interface StreamingMarkdownInput {
	text: string;
	streaming: boolean;
	key?: string;
	annotate: boolean;
	projectPath?: string;
}

/**
 * Stateful incremental Markdown parser for streaming replies.
 *
 * While `streaming` is true, closed top-level blocks before the active tail are
 * parsed and link-annotated once and reused by reference so every incoming
 * token only parses the small trailing block(s). Cross-block syntax (footnotes,
 * reference link definitions, or duplicate heading anchors across chunks) and
 * settled (`streaming: false`) documents fall back to a full parse for exact
 * CommonMark/GFM parity.
 */
export function createStreamingMarkdownParser<
	TDoc extends StreamingMarkdownDocumentLike,
>(options: StreamingMarkdownParserOptions<TDoc>) {
	const annotateFull =
		options.annotateDocument ??
		((doc: TDoc, projectPath?: string) =>
			annotateMarkdownDocumentFileLinks(
				doc as Parameters<typeof annotateMarkdownDocumentFileLinks>[0],
				projectPath,
			) as unknown as TDoc);
	const makeAnnotator =
		options.createAnnotator ??
		(() => {
			const inner = createMarkdownFileLinkAnnotator();
			return (doc: TDoc, projectPath?: string) =>
				inner(
					doc as Parameters<typeof inner>[0],
					projectPath,
				) as unknown as TDoc;
		});

	let fullAnnotator = makeAnnotator();
	let tailAnnotator = makeAnnotator();

	let lastKey: string | undefined;
	let lastAnnotate = false;
	let lastProjectPath: string | undefined;
	let lastText: string | undefined;
	let lastStreaming: boolean | undefined;
	let lastResult: TDoc | undefined;

	let stableOffset = 0;
	let stableText = "";
	let stableBlocks: unknown[] = [];
	let stableAnchors = new Set<string>();
	let fallbackToFull = false;

	const resetIncremental = () => {
		stableOffset = 0;
		stableText = "";
		stableBlocks = [];
		stableAnchors = new Set<string>();
		fallbackToFull = false;
		tailAnnotator = makeAnnotator();
	};

	const hasDuplicateAnchorWithStable = (
		blocks: readonly unknown[],
	): boolean => {
		if (stableAnchors.size === 0) return false;
		const anchors: string[] = [];
		collectHeadingAnchors(blocks, anchors);
		for (const anchor of anchors) {
			if (stableAnchors.has(anchor)) return true;
		}
		return false;
	};

	return function parseDocument(input: StreamingMarkdownInput): TDoc {
		const { text, streaming, key, annotate, projectPath } = input;
		const effectiveProjectPath = annotate ? projectPath : undefined;

		if (
			lastResult !== undefined &&
			text === lastText &&
			streaming === lastStreaming &&
			key === lastKey &&
			annotate === lastAnnotate &&
			effectiveProjectPath === lastProjectPath
		) {
			return lastResult;
		}

		const scopeChanged =
			key !== lastKey ||
			annotate !== lastAnnotate ||
			effectiveProjectPath !== lastProjectPath;
		if (scopeChanged) {
			resetIncremental();
			fullAnnotator = makeAnnotator();
		}

		let result: TDoc;
		if (!streaming) {
			resetIncremental();
			const parsed = options.parse(text, false);
			result = annotate ? fullAnnotator(parsed, effectiveProjectPath) : parsed;
		} else {
			if (
				stableOffset > 0 &&
				(text.length < stableOffset || !text.startsWith(stableText))
			) {
				resetIncremental();
			}

			if (!fallbackToFull) {
				const split = findStableMarkdownSplit(text, stableOffset);
				if (split.fallbackToFull) {
					resetIncremental();
					fallbackToFull = true;
				} else if (split.splitOffset > stableOffset) {
					const newlyStable = text.slice(stableOffset, split.splitOffset);
					const parsedChunk = options.parse(newlyStable, false);
					if (
						(parsedChunk.footnotes && parsedChunk.footnotes.length > 0) ||
						hasDuplicateAnchorWithStable(parsedChunk.blocks)
					) {
						resetIncremental();
						fallbackToFull = true;
					} else {
						const annotatedChunk = annotate
							? annotateFull(parsedChunk, effectiveProjectPath)
							: parsedChunk;
						const chunkAnchors: string[] = [];
						collectHeadingAnchors(annotatedChunk.blocks, chunkAnchors);
						for (const anchor of chunkAnchors) stableAnchors.add(anchor);
						for (const block of annotatedChunk.blocks) {
							stableBlocks.push(block);
						}
						stableOffset = split.splitOffset;
						stableText = text.slice(0, stableOffset);
						tailAnnotator = makeAnnotator();
					}
				}
			}

			if (fallbackToFull) {
				const parsed = options.parse(text, true);
				result = annotate
					? fullAnnotator(parsed, effectiveProjectPath)
					: parsed;
			} else if (stableOffset === 0) {
				const parsed = options.parse(text, true);
				result = annotate
					? tailAnnotator(parsed, effectiveProjectPath)
					: parsed;
			} else {
				const activeTail = text.slice(stableOffset);
				const parsedTail = options.parse(activeTail, true);
				if (
					(parsedTail.footnotes && parsedTail.footnotes.length > 0) ||
					hasDuplicateAnchorWithStable(parsedTail.blocks)
				) {
					resetIncremental();
					fallbackToFull = true;
					const parsed = options.parse(text, true);
					result = annotate
						? fullAnnotator(parsed, effectiveProjectPath)
						: parsed;
				} else {
					const annotatedTail = annotate
						? tailAnnotator(parsedTail, effectiveProjectPath)
						: parsedTail;
					result = {
						...annotatedTail,
						blocks: stableBlocks.concat(annotatedTail.blocks),
					};
				}
			}
		}

		lastKey = key;
		lastAnnotate = annotate;
		lastProjectPath = effectiveProjectPath;
		lastText = text;
		lastStreaming = streaming;
		lastResult = result;
		return result;
	};
}
