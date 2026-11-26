import { languageForPath } from "@shared/code-languages";
import type { WorkspaceLineRange } from "@shared/project-workspace";

function hasUnsafePathCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code === 92 || code < 32 || (code >= 127 && code <= 159)) {
			return true;
		}
	}
	return false;
}

/** File links are user-activated previews/system opens, never browser navigation. */
export function resolveMarkdownFileUrl(value: string): string | null {
	if (
		!/^file:\/\//i.test(value) ||
		value.length > 4096 ||
		hasUnsafePathCharacters(value) ||
		/%(?:2f|5c)/i.test(value)
	)
		return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "file:" ||
			(url.hostname && url.hostname !== "localhost") ||
			/[?#]/.test(url.href)
		)
			return null;
		const path = decodeURIComponent(url.pathname);
		if (
			!path.startsWith("/") ||
			path.startsWith("//") ||
			hasUnsafePathCharacters(path) ||
			path.replace(/^\/[a-z]:\//i, "/").includes(":") ||
			path.endsWith("/")
		)
			return null;
		return url.href;
	} catch {
		return null;
	}
}

// Split at the first dot to avoid backtracking across dotted filenames.
const ROOT_FILE_LINE_REFERENCE =
	/^(?:[^/:.]*\.[^/:]+|dockerfile|makefile|justfile|license|readme):L?\d+(?::\d+)?(?:-L?\d+(?::\d+)?)?(?:#.*)?$/i;
const FILE_LINE_SUFFIX = /:L?(\d+)(?::\d+)?(?:-L?(\d+)(?::\d+)?)?$/i;
const FILE_LINE_FRAGMENT = /^L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i;

export type ChatFileLink = {
	url: string;
	lineRange?: WorkspaceLineRange;
};

export function formatChatFileLinkHref(link: ChatFileLink): string {
	if (!link.lineRange) return link.url;
	const { start, end } = link.lineRange;
	return start === end
		? `${link.url}#L${start}`
		: `${link.url}#L${start}-L${end}`;
}

function markdownFileLocation(value: string): {
	path: string;
	lineRange?: WorkspaceLineRange;
} | null {
	if (value.length > 4096 || hasUnsafePathCharacters(value)) return null;
	const hash = value.indexOf("#");
	const path = hash < 0 ? value : value.slice(0, hash);
	const suffix = FILE_LINE_SUFFIX.exec(path);
	const fragment =
		hash < 0 ? null : FILE_LINE_FRAGMENT.exec(value.slice(hash + 1));
	const match = fragment ?? suffix;
	if (!match) return { path };
	const start = Number(match[1]);
	const end = Number(match[2] ?? match[1]);
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 1 ||
		end < start
	)
		return null;
	return {
		path: suffix ? path.slice(0, suffix.index) : path,
		lineRange: { start, end },
	};
}

/** Resolve a literal path from a file picker, mention or tool without treating its name as URL syntax. */
export function resolveLiteralFileLink(
	path: string,
	projectPath?: string,
): ReturnType<typeof resolveMarkdownFileLink> {
	const normalized = path
		.replaceAll("\\", "/")
		.replace(/^\/\/\?\/([a-z]:\/)/i, "$1");
	if (
		!normalized ||
		normalized.length > 4096 ||
		normalized.startsWith("~") ||
		normalized.startsWith("//")
	)
		return null;
	try {
		const encoded = normalized.split("/").map(encodeURIComponent).join("/");
		const href = normalized.startsWith("/")
			? `file://${encoded}`
			: /^[a-z]:\//i.test(normalized)
				? `file:///${encoded.replace(/^([a-z])%3A\//i, "$1:/")}`
				: encoded;
		return resolveMarkdownFileLink(href, projectPath);
	} catch {
		return null;
	}
}

/** The assistant may write an absolute path or Windows-style path directly instead of a file URL. */
export function resolveChatFileLink(
	value: string,
	projectPath?: string,
): ChatFileLink | null {
	if (!value || value.length > 4096 || value.startsWith("~/")) return null;
	if (/^file:/i.test(value)) {
		return resolveMarkdownFileLink(value, projectPath);
	}
	const strippedVerbatim = value.replace(/^\\\\\?\\([a-z]:[\\/])/i, "$1");
	if (strippedVerbatim.startsWith("/") && !strippedVerbatim.startsWith("//")) {
		return resolveMarkdownFileLink(`file://${strippedVerbatim}`);
	}
	if (/^[a-z]:[\\/]/i.test(strippedVerbatim)) {
		return resolveMarkdownFileLink(
			`file:///${strippedVerbatim.replaceAll("\\", "/")}`,
		);
	}
	if (
		strippedVerbatim.startsWith("//") ||
		strippedVerbatim.startsWith("\\\\")
	) {
		return null;
	}
	const normalized = strippedVerbatim.includes("\\")
		? strippedVerbatim.replaceAll("\\", "/")
		: strippedVerbatim;
	return resolveMarkdownFileLink(normalized, projectPath);
}

function relativeMarkdownFilePath(value: string): string | null {
	// A root-level filename with a line suffix is not a URL scheme.
	if (
		value.length > 4096 ||
		hasUnsafePathCharacters(value) ||
		(/^[a-z][a-z\d+.-]*:/i.test(value) && !ROOT_FILE_LINE_REFERENCE.test(value))
	)
		return null;
	const location = markdownFileLocation(value);
	if (!location) return null;
	let path: string;
	try {
		path = decodeURIComponent(location.path);
	} catch {
		return null;
	}
	if (
		!path ||
		path.startsWith("/") ||
		/[:?]/.test(path) ||
		/%(?:2f|5c)/i.test(value) ||
		hasUnsafePathCharacters(path) ||
		path.endsWith("/")
	)
		return null;
	const segments: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "..") {
			if (!segments.length) return null;
			segments.pop();
		} else if (segment && segment !== ".") segments.push(segment);
	}
	return segments.length ? segments.join("/") : null;
}

function resolveRelativeProjectFileUrl(
	value: string,
	projectPath?: string,
): string | null {
	const relativePath = relativeMarkdownFilePath(value);
	if (!relativePath || !projectPath) return null;
	const root = projectPath
		.replace(/\\/g, "/")
		.replace(/^\/\/\?\/([a-z]:\/)/i, "$1");
	if (
		root.startsWith("//") ||
		(!root.startsWith("/") && !/^[a-z]:\//i.test(root))
	)
		return null;
	try {
		const encodedRoot = root
			.split("/")
			.map(encodeURIComponent)
			.join("/")
			.replace(/^([a-z])%3A\//i, "$1:/")
			.replace(/\/+$/, "");
		const encodedPath = relativePath
			.split("/")
			.map(encodeURIComponent)
			.join("/");
		return resolveMarkdownFileUrl(
			`file://${root.startsWith("/") ? "" : "/"}${encodedRoot}/${encodedPath}`,
		);
	} catch {
		return null;
	}
}

/** Resolve against the owning project; never send line/fragment syntax to IPC. */
export function resolveMarkdownFileLink(
	value: string,
	projectPath?: string,
): { url: string; lineRange?: WorkspaceLineRange } | null {
	const location = markdownFileLocation(value);
	if (!location) return null;
	const absolute = /^file:/i.test(value);
	// Absolute file URLs still reject arbitrary fragments and queries.
	const hash = value.indexOf("#");
	if (absolute && hash >= 0 && !FILE_LINE_FRAGMENT.test(value.slice(hash + 1)))
		return null;
	const url = absolute
		? resolveMarkdownFileUrl(location.lineRange ? location.path : value)
		: resolveRelativeProjectFileUrl(value, projectPath);
	if (!url) return null;
	const preview = fileLinkPreviewKind(
		decodeURIComponent(new URL(url).pathname),
	);
	if (absolute && location.lineRange && !preview) return null;
	return {
		url,
		...(preview && location.lineRange ? { lineRange: location.lineRange } : {}),
	};
}

const CODE_PREVIEW_EXTENSIONS = new Set([
	"c",
	"h",
	"cc",
	"cpp",
	"cxx",
	"hpp",
	"cs",
	"java",
	"kt",
	"kts",
	"swift",
	"m",
	"mm",
	"rb",
	"php",
	"vue",
	"svelte",
	"astro",
	"sql",
	"toml",
	"xml",
	"svg",
	"ini",
	"conf",
	"cfg",
	"txt",
	"rst",
	"log",
	"env",
	"gitignore",
	"gitattributes",
	"editorconfig",
	"npmrc",
	"dockerignore",
	"fish",
	"ps1",
	"psm1",
	"bat",
	"cmd",
	"pl",
	"r",
	"lua",
	"dart",
	"scss",
	"sass",
	"less",
	"styl",
	"jsonc",
	"json5",
	"jsonl",
	"zig",
	"proto",
	"graphql",
	"gql",
	"ex",
	"exs",
	"erl",
	"hs",
	"ml",
	"scala",
	"wgsl",
	"glsl",
	"pyi",
	"pyw",
	"lock",
	"properties",
	"tsv",
]);

const SPECIAL_CODE_FILENAMES = new Set([
	"dockerfile",
	"makefile",
	"justfile",
	"license",
	"readme",
	".gitignore",
	".gitattributes",
	".editorconfig",
	".npmrc",
	".dockerignore",
	".env",
]);

const SYSTEM_OPENABLE_EXTENSIONS = new Set([
	"html",
	"htm",
	"pdf",
	"csv",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"bmp",
	"ico",
	"tif",
	"tiff",
	"avif",
]);

// Bare single-segment code tokens like `console.log` or `process.env` should not auto-link without a path or line suffix.
const AMBIGUOUS_BARE_EXTENSIONS = new Set(["log", "env", "r", "m", "c", "h"]);

function isSpecialCodeFileName(name: string): boolean {
	return (
		SPECIAL_CODE_FILENAMES.has(name) ||
		name.startsWith(".env.") ||
		name.startsWith("dockerfile.")
	);
}

export function fileLinkPreviewKind(path: string): "markdown" | "code" | null {
	const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
	if (!name) return null;
	if (isSpecialCodeFileName(name)) return "code";
	const dot = name.lastIndexOf(".");
	const extension = dot > 0 ? name.slice(dot + 1) : "";
	if (extension === "md" || extension === "markdown") return "markdown";
	// HTML stays in the browser; MDX is source, never evaluated.
	if (extension === "html" || extension === "htm") return null;
	if (
		(extension && languageForPath(name)) ||
		(extension && CODE_PREVIEW_EXTENSIONS.has(extension))
	)
		return "code";
	return null;
}

function isKnownOpenableFilePath(
	filePath: string,
	hasLineRange: boolean,
): boolean {
	const normalized = filePath.replaceAll("\\", "/");
	const hasSlash = normalized.includes("/");
	const name = normalized.split("/").at(-1)?.toLowerCase() ?? "";
	if (!name) return false;
	const isSpecial = isSpecialCodeFileName(name);
	if (isSpecial) return true;
	const dot = name.lastIndexOf(".");
	const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "";
	const openable =
		fileLinkPreviewKind(name) !== null ||
		(Boolean(extension) && SYSTEM_OPENABLE_EXTENSIONS.has(extension));
	if (openable) {
		if (
			!hasSlash &&
			!hasLineRange &&
			AMBIGUOUS_BARE_EXTENSIONS.has(extension)
		) {
			return false;
		}
		return true;
	}
	// Extensionless file under a directory with an explicit line number (e.g. `scripts/deploy:12`).
	if (
		hasSlash &&
		hasLineRange &&
		/^[a-z0-9._-]+$/i.test(name) &&
		/[a-z]/i.test(name)
	) {
		return true;
	}
	return false;
}

function parseLineRangePair(
	startText: string | undefined,
	endText: string | undefined,
): WorkspaceLineRange | null {
	const start = Number(startText);
	const end = Number(endText ?? startText);
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 1 ||
		end < start
	)
		return null;
	return { start, end };
}

/** Resolve an inline-code token like `` `src/main.ts:42` `` or `` `Cargo.toml` `` into a file link. */
export function resolveInlineCodeFileLink(
	code: string,
	projectPath?: string,
): ChatFileLink | null {
	if (
		!code ||
		code.length > 4096 ||
		/\s/.test(code) ||
		code.startsWith("@") ||
		/^(?:https?|mailto|wss?|ftp|data|javascript):/i.test(code)
	)
		return null;
	const resolved = resolveChatFileLink(code, projectPath);
	if (!resolved) return null;
	if (/^file:/i.test(code)) return resolved;
	const normalized = code
		.replace(/^\\\\\?\\([a-z]:[\\/])/i, "$1")
		.replaceAll("\\", "/");
	const location = markdownFileLocation(normalized);
	if (!location) return null;
	return isKnownOpenableFilePath(
		location.path,
		resolved.lineRange !== undefined,
	)
		? resolved
		: null;
}

const DIRECT_TRAILING_LINE_SUFFIX =
	/^(:L?(\d+)(?::\d+)?(?:-L?(\d+)(?::\d+)?)?|#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?)(?![A-Za-z0-9_/-])/i;
const PROSE_TRAILING_LINE_PATTERNS = [
	/^\s*\(\s*(?:lines?|L)\s*(\d+)(?:\s*[-–~]\s*L?(\d+))?\s*\)/i,
	/^\s*[（(]\s*第\s*(\d+)(?:\s*(?:行\s*)?[-–~到至]\s*(?:第\s*)?(\d+))?\s*行\s*[）)]/,
	/^\s*第\s*(\d+)(?:\s*(?:行\s*)?[-–~到至]\s*(?:第\s*)?(\d+))?\s*行/,
	/^\s+(?:lines?\s+|L)(\d+)(?:\s*[-–~]\s*L?(\d+))?(?![A-Za-z0-9_])/i,
];

/** Extract a line range immediately following an inline-code file token (e.g. `` `a.ts`:42 `` or `` `a.ts` (line 42) ``). */
export function extractTrailingLineRange(text: string): {
	lineRange: WorkspaceLineRange;
	consumeLength: number;
} | null {
	const direct = DIRECT_TRAILING_LINE_SUFFIX.exec(text);
	if (direct) {
		const lineRange = parseLineRangePair(
			direct[2] ?? direct[4],
			direct[3] ?? direct[5],
		);
		if (lineRange) return { lineRange, consumeLength: direct[1].length };
		return null;
	}
	for (const pattern of PROSE_TRAILING_LINE_PATTERNS) {
		const match = pattern.exec(text);
		if (!match) continue;
		const lineRange = parseLineRangePair(match[1], match[2]);
		if (lineRange) return { lineRange, consumeLength: 0 };
		return null;
	}
	return null;
}

export type PlainTextFileLinkSegment =
	| { type: "text"; text: string }
	| { type: "link"; text: string; link: ChatFileLink };

const PLAIN_TEXT_TOKEN_PATTERN =
	/(?:https?|mailto|wss?|ftp):\/\/[^\s<>()[\]{}"'\u3000-\u303F\uFF00-\uFFEF]+|mailto:[^\s<>()[\]{}"'\u3000-\u303F\uFF00-\uFFEF]+|file:\/\/[^\s<>()[\]{}"'`\u3000-\u303F\uFF00-\uFFEF]+|(?:\\\\\?\\)?[a-zA-Z]:[\\/][^\s<>()[\]{}"'`\u3000-\u303F\uFF00-\uFFEF]+|(?<![A-Za-z0-9_@:])(?:(?:\.{1,2}[\\/]|[\\/])?[A-Za-z0-9._+-]+(?:[\\/][A-Za-z0-9._+-]+)*(?:[\\/](?:[^\s<>()[\]{}"'`/\\:#,\u3000-\u303F\uFF00-\uFFEF]+\.[A-Za-z0-9]+|[A-Za-z0-9._+-]+))(?::L?\d+(?::\d+)?(?:-L?\d+(?::\d+)?)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)?|(?:[A-Za-z0-9._+-]*\.[A-Za-z0-9._+-]+|dockerfile|makefile|justfile|license|readme)(?::L?\d+(?::\d+)?(?:-L?\d+(?::\d+)?)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?))/gi;

const TRAILING_PUNCTUATION = /[.,;:!?）)】」》"'，。；：、]+$/;

/** Split plain prose text into ordinary text and unambiguous file-path link segments. */
export function splitPlainTextFileLinks(
	text: string,
	projectPath?: string,
): PlainTextFileLinkSegment[] {
	if (!text) return [];
	const segments: PlainTextFileLinkSegment[] = [];
	let cursor = 0;
	PLAIN_TEXT_TOKEN_PATTERN.lastIndex = 0;
	for (const match of text.matchAll(PLAIN_TEXT_TOKEN_PATTERN)) {
		const raw = match[0];
		const start = match.index;
		if (/^(?:https?|mailto|wss?|ftp):/i.test(raw) || raw.startsWith("@")) {
			continue;
		}
		const trimmed = raw.replace(TRAILING_PUNCTUATION, "");
		if (!trimmed) continue;
		// Require a clean left boundary for absolute POSIX paths or relative tokens.
		if (start > 0) {
			const prev = text[start - 1];
			if (prev && /[A-Za-z0-9_@]/.test(prev)) continue;
		}
		const isFileUrl = /^file:/i.test(trimmed);
		let resolved = resolveChatFileLink(trimmed, projectPath);
		if (!resolved) continue;
		if (!isFileUrl) {
			const normalized = trimmed
				.replace(/^\\\\\?\\([a-z]:[\\/])/i, "$1")
				.replaceAll("\\", "/");
			const location = markdownFileLocation(normalized);
			if (!location) continue;
			const hasSlash = location.path.includes("/");
			// Plain-text single filenames require an explicit line location to avoid matching prose like `Node.js`.
			if (!hasSlash && !resolved.lineRange) continue;
			if (
				!isKnownOpenableFilePath(
					location.path,
					resolved.lineRange !== undefined,
				)
			) {
				continue;
			}
		}
		if (
			!resolved.lineRange &&
			fileLinkPreviewKind(
				decodeURIComponent(new URL(resolved.url).pathname),
			) !== null
		) {
			const trailing = extractTrailingLineRange(
				text.slice(start + trimmed.length),
			);
			if (trailing && trailing.consumeLength === 0) {
				resolved = { ...resolved, lineRange: trailing.lineRange };
			}
		}
		if (start > cursor) {
			segments.push({ type: "text", text: text.slice(cursor, start) });
		}
		segments.push({ type: "link", text: trimmed, link: resolved });
		cursor = start + trimmed.length;
	}
	if (cursor === 0) return [{ type: "text", text }];
	if (cursor < text.length) {
		segments.push({ type: "text", text: text.slice(cursor) });
	}
	return segments;
}

export type MarkdownInlineLike = {
	readonly type: string;
	readonly text?: string;
	readonly code?: string;
	readonly url?: string;
	readonly title?: string;
	readonly content?: readonly MarkdownInlineLike[];
	readonly children?: readonly MarkdownBlockLike[];
};

export type MarkdownBlockLike = {
	readonly type: string;
	readonly content?: readonly MarkdownInlineLike[];
	readonly children?: readonly MarkdownBlockLike[];
	readonly summary?: readonly MarkdownInlineLike[];
	readonly items?: readonly {
		readonly checked?: boolean;
		readonly children: readonly MarkdownBlockLike[];
	}[];
	readonly head?: readonly {
		readonly content: readonly MarkdownInlineLike[];
		readonly colspan?: number;
	}[];
	readonly rows?: readonly (readonly {
		readonly content: readonly MarkdownInlineLike[];
		readonly colspan?: number;
	}[])[];
};

export type MarkdownDocumentLike = {
	readonly blocks: readonly MarkdownBlockLike[];
	readonly footnotes?: readonly {
		readonly label: string;
		readonly index: number;
		readonly children: readonly MarkdownBlockLike[];
	}[];
};

function plainInlineText(inlines: readonly MarkdownInlineLike[]): string {
	let out = "";
	for (const node of inlines) {
		if (node.type === "text" && typeof node.text === "string") {
			out += node.text;
		} else if (node.type === "code" && typeof node.code === "string") {
			out += node.code;
		} else if (Array.isArray(node.content)) {
			out += plainInlineText(node.content);
		}
	}
	return out;
}

function unwrapCodeInFileLink(
	inlines: readonly MarkdownInlineLike[],
): MarkdownInlineLike[] {
	const result: MarkdownInlineLike[] = [];
	for (const node of inlines) {
		if (node.type === "code" && typeof node.code === "string") {
			result.push({ type: "text", text: node.code });
		} else if (Array.isArray(node.content)) {
			result.push({
				...node,
				content: unwrapCodeInFileLink(node.content),
			});
		} else {
			result.push(node);
		}
	}
	return result;
}

function annotateInlines(
	inlines: readonly MarkdownInlineLike[],
	projectPath?: string,
): MarkdownInlineLike[] {
	const result: MarkdownInlineLike[] = [];
	for (let index = 0; index < inlines.length; index += 1) {
		const node = inlines[index];
		if (
			node.type === "link" &&
			typeof node.url === "string" &&
			Array.isArray(node.content)
		) {
			if (!/^(?:https?:|mailto:|#)/i.test(node.url)) {
				const resolved = resolveChatFileLink(node.url, projectPath);
				if (resolved) {
					let target = resolved;
					if (!resolved.lineRange) {
						const labelText = plainInlineText(node.content).trim();
						const labelResolved = labelText
							? resolveChatFileLink(labelText, projectPath)
							: null;
						if (
							labelResolved &&
							labelResolved.lineRange &&
							labelResolved.url === resolved.url
						) {
							target = labelResolved;
						}
					}
					// nsh TextView only attaches link press handlers to text spans, not `code` leaves inside links.
					result.push({
						...node,
						url: formatChatFileLinkHref(target),
						content: unwrapCodeInFileLink(node.content),
					});
					continue;
				}
			}
			result.push(node);
			continue;
		}
		if (node.type === "code" && typeof node.code === "string") {
			const resolved = resolveInlineCodeFileLink(node.code, projectPath);
			if (resolved) {
				let link = resolved;
				let trailingCodeSuffix = "";
				const next = inlines[index + 1];
				const canHaveLineRange =
					fileLinkPreviewKind(
						decodeURIComponent(new URL(resolved.url).pathname),
					) !== null;
				if (
					!resolved.lineRange &&
					canHaveLineRange &&
					next &&
					next.type === "text" &&
					typeof next.text === "string"
				) {
					const trailing = extractTrailingLineRange(next.text);
					if (trailing) {
						link = { ...resolved, lineRange: trailing.lineRange };
						if (trailing.consumeLength > 0) {
							trailingCodeSuffix = next.text.slice(0, trailing.consumeLength);
							const remainder = next.text.slice(trailing.consumeLength);
							if (remainder) {
								// Replace the consumed prefix before processing the remainder on the next turn.
								const mutable = [...inlines];
								mutable[index + 1] = { ...next, text: remainder };
								inlines = mutable;
							} else {
								index += 1;
							}
						}
					}
				}
				result.push({
					type: "link",
					url: formatChatFileLinkHref(link),
					content: [{ type: "text", text: node.code + trailingCodeSuffix }],
				});
				continue;
			}
			result.push(node);
			continue;
		}
		if (node.type === "text" && typeof node.text === "string") {
			const segments = splitPlainTextFileLinks(node.text, projectPath);
			if (segments.length === 1 && segments[0]?.type === "text") {
				result.push(node);
			} else {
				for (const segment of segments) {
					if (segment.type === "text") {
						result.push({ type: "text", text: segment.text });
					} else {
						result.push({
							type: "link",
							url: formatChatFileLinkHref(segment.link),
							content: [{ type: "text", text: segment.text }],
						});
					}
				}
			}
			continue;
		}
		if (
			(node.type === "strong" ||
				node.type === "emphasis" ||
				node.type === "strikethrough" ||
				node.type === "underline" ||
				node.type === "superscript" ||
				node.type === "subscript" ||
				node.type === "small" ||
				node.type === "highlight") &&
			Array.isArray(node.content)
		) {
			result.push({
				...node,
				content: annotateInlines(node.content, projectPath),
			});
			continue;
		}
		result.push(node);
	}
	return result;
}

function annotateTableCells(
	cells: readonly {
		readonly content: readonly MarkdownInlineLike[];
		readonly colspan?: number;
	}[],
	projectPath?: string,
) {
	const result: { content: MarkdownInlineLike[]; colspan?: number }[] = [];
	for (const cell of cells) {
		result.push({
			...cell,
			content: annotateInlines(cell.content, projectPath),
		});
	}
	return result;
}

function annotateBlocks(
	blocks: readonly MarkdownBlockLike[],
	projectPath?: string,
): MarkdownBlockLike[] {
	const result: MarkdownBlockLike[] = [];
	for (const block of blocks) {
		switch (block.type) {
			case "paragraph":
			case "heading": {
				if (Array.isArray(block.content)) {
					result.push({
						...block,
						content: annotateInlines(block.content, projectPath),
					});
					break;
				}
				result.push(block);
				break;
			}
			case "blockquote": {
				if (Array.isArray(block.children)) {
					result.push({
						...block,
						children: annotateBlocks(block.children, projectPath),
					});
					break;
				}
				result.push(block);
				break;
			}
			case "list": {
				if (Array.isArray(block.items)) {
					const items: {
						checked?: boolean;
						children: MarkdownBlockLike[];
					}[] = [];
					for (const item of block.items) {
						items.push({
							...item,
							children: annotateBlocks(item.children, projectPath),
						});
					}
					result.push({ ...block, items });
					break;
				}
				result.push(block);
				break;
			}
			case "table": {
				if (Array.isArray(block.head)) {
					const rows = block.rows
						? block.rows.map((row) => annotateTableCells(row, projectPath))
						: undefined;
					result.push({
						...block,
						head: annotateTableCells(block.head, projectPath),
						...(rows ? { rows } : {}),
					});
					break;
				}
				result.push(block);
				break;
			}
			case "details": {
				if (Array.isArray(block.summary) && Array.isArray(block.children)) {
					result.push({
						...block,
						summary: annotateInlines(block.summary, projectPath),
						children: annotateBlocks(block.children, projectPath),
					});
					break;
				}
				result.push(block);
				break;
			}
			case "custom": {
				result.push({
					...block,
					...(Array.isArray(block.children)
						? { children: annotateBlocks(block.children, projectPath) }
						: {}),
					...(Array.isArray(block.content)
						? { content: annotateInlines(block.content, projectPath) }
						: {}),
				});
				break;
			}
			default:
				result.push(block);
				break;
		}
	}
	return result;
}

function sameMarkdownValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i += 1) {
			if (!sameMarkdownValue(a[i], b[i])) return false;
		}
		return true;
	}
	if (Array.isArray(b)) return false;
	const aObj = a as Record<string, unknown>;
	const bObj = b as Record<string, unknown>;
	const keys = Object.keys(aObj);
	if (keys.length !== Object.keys(bObj).length) return false;
	for (let i = 0; i < keys.length; i += 1) {
		const key = keys[i];
		if (!Object.hasOwn(bObj, key) || !sameMarkdownValue(aObj[key], bObj[key])) {
			return false;
		}
	}
	return true;
}

function annotateSingleBlock(
	block: MarkdownBlockLike,
	projectPath?: string,
): MarkdownBlockLike {
	return annotateBlocks([block], projectPath)[0] ?? block;
}

/**
 * Stateful annotator for streaming Markdown documents: reuses annotated
 * blocks for unchanged prefixes so streaming tokens only re-annotate the
 * active trailing block(s) instead of walking the full AST on every delta.
 */
export function createMarkdownFileLinkAnnotator() {
	let lastProjectPath: string | undefined;
	let lastRawBlocks: readonly MarkdownBlockLike[] = [];
	let lastAnnotatedBlocks: MarkdownBlockLike[] = [];
	let lastRawFootnotes: MarkdownDocumentLike["footnotes"];
	let lastAnnotatedFootnotes: MarkdownDocumentLike["footnotes"];

	return function annotate<T extends MarkdownDocumentLike>(
		document: T,
		projectPath?: string,
	): T {
		if (projectPath !== lastProjectPath) {
			lastProjectPath = projectPath;
			lastRawBlocks = [];
			lastAnnotatedBlocks = [];
			lastRawFootnotes = undefined;
			lastAnnotatedFootnotes = undefined;
		}

		const blocks = document.blocks;
		let unchangedPrefix = 0;
		const limit = Math.min(blocks.length, lastRawBlocks.length);
		while (
			unchangedPrefix < limit &&
			sameMarkdownValue(blocks[unchangedPrefix], lastRawBlocks[unchangedPrefix])
		) {
			unchangedPrefix += 1;
		}

		let annotatedBlocks: MarkdownBlockLike[];
		if (
			unchangedPrefix === blocks.length &&
			blocks.length === lastAnnotatedBlocks.length
		) {
			annotatedBlocks = lastAnnotatedBlocks;
		} else {
			annotatedBlocks = lastAnnotatedBlocks.slice(0, unchangedPrefix);
			for (let i = unchangedPrefix; i < blocks.length; i += 1) {
				annotatedBlocks.push(annotateSingleBlock(blocks[i], projectPath));
			}
			lastRawBlocks = blocks;
			lastAnnotatedBlocks = annotatedBlocks;
		}

		let footnotes = document.footnotes;
		if (footnotes) {
			if (
				lastRawFootnotes &&
				sameMarkdownValue(footnotes, lastRawFootnotes) &&
				lastAnnotatedFootnotes
			) {
				footnotes = lastAnnotatedFootnotes;
			} else {
				const nextFootnotes = footnotes.map((footnote) =>
					Object.assign({}, footnote, {
						children: annotateBlocks(footnote.children, projectPath),
					}),
				);
				lastRawFootnotes = footnotes;
				lastAnnotatedFootnotes = nextFootnotes;
				footnotes = nextFootnotes;
			}
		} else {
			lastRawFootnotes = undefined;
			lastAnnotatedFootnotes = undefined;
		}

		return {
			...document,
			blocks: annotatedBlocks,
			...(footnotes ? { footnotes } : {}),
		} as T;
	};
}

/** Annotate a parsed Markdown document (`TextView.parse`) with clickable file links from inline code and plain text. */
export function annotateMarkdownDocumentFileLinks<
	T extends MarkdownDocumentLike,
>(document: T, projectPath?: string): T {
	const footnotes = document.footnotes
		? document.footnotes.map((footnote) =>
				Object.assign({}, footnote, {
					children: annotateBlocks(footnote.children, projectPath),
				}),
			)
		: undefined;
	return {
		...document,
		blocks: annotateBlocks(document.blocks, projectPath),
		...(footnotes ? { footnotes } : {}),
	} as T;
}

type LinkNode = {
	type?: string;
	value?: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: LinkNode[];
};

function visitFileLinks(node: LinkNode) {
	const props = node.properties;
	if (
		node.tagName === "a" &&
		props &&
		typeof props.href === "string" &&
		(/^file:/i.test(props.href) ||
			(Boolean(props.href) && !/^(?:[a-z][a-z\d+.-]*:|[/#])/i.test(props.href)))
	) {
		const target = /^file:/i.test(props.href)
			? resolveMarkdownFileLink(props.href)
			: null;
		const children = node.children ?? [];
		const labelTarget =
			target && children.every((child) => child.type === "text")
				? resolveMarkdownFileLink(
						children
							.map((child) => child.value ?? "")
							.join("")
							.trim(),
					)
				: null;
		if (
			target &&
			labelTarget &&
			target.url === labelTarget.url &&
			target.lineRange?.start === labelTarget.lineRange?.start &&
			target.lineRange?.end === labelTarget.lineRange?.end
		) {
			const location = target.lineRange;
			const suffix = location
				? `:${location.start}${location.end === location.start ? "" : `-${location.end}`}`
				: "";
			node.children = [
				{
					type: "text",
					value:
						decodeURIComponent(
							new URL(target.url).pathname.split("/").at(-1) ?? "",
						) + suffix,
				},
			];
		}
		props["data-pilo-file-url"] = props.href;
		// Never let the browser navigate directly to a file URL, even with modifier clicks.
		props.href = "https://pilo.invalid/file-link";
	}
	const children = node.children ?? [];
	for (const child of children) visitFileLinks(child);
	// Only file-only paragraphs/list items become attachment rows, never prose.
	if (
		(node.tagName === "p" || node.tagName === "li") &&
		children.every(
			(child) =>
				(child.type === "text" && !child.value?.trim()) ||
				child.tagName === "br" ||
				(child.tagName === "a" &&
					child.properties?.["data-pilo-file-url"] !== undefined),
		)
	) {
		for (const child of children) {
			if (child.properties?.["data-pilo-file-url"] !== undefined) {
				child.properties["data-pilo-file-layout"] = "standalone";
			}
		}
	}
}

/** Preserve root-level `file.ts:line[-line]` links through protocol sanitization. */
export function rehypeRelativeFileLinks() {
	return function visit(node: LinkNode) {
		const props = node.properties;
		if (
			node.tagName === "a" &&
			props &&
			typeof props.href === "string" &&
			relativeMarkdownFilePath(props.href) !== null &&
			ROOT_FILE_LINE_REFERENCE.test(props.href)
		)
			props.href = `./${props.href}`;
		for (const child of node.children ?? []) visit(child);
	};
}

/** After sanitize, preserve file targets for our component before harden blocks them. */
export function rehypeFileLinks() {
	return visitFileLinks;
}
