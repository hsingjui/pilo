import type { CodeHighlighterPlugin, HighlightOptions } from "streamdown";
import {
	CODE_THEME_NAME,
	getCodeHighlighter,
	type CodeLanguage,
} from "@/lib/code-highlighter";

type ShikiHighlighter = Awaited<
	ReturnType<(typeof import("shiki/core"))["createHighlighterCore"]>
>;
type MarkdownHighlightResult = NonNullable<
	ReturnType<CodeHighlighterPlugin["highlight"]>
>;

const MARKDOWN_CODE_THEMES = [CODE_THEME_NAME, CODE_THEME_NAME] as const;

const MARKDOWN_CODE_LANGUAGES = [
	"typescript",
	"tsx",
	"javascript",
	"jsx",
	"json",
	"bash",
	"shellscript",
	"markdown",
	"python",
	"rust",
	"go",
	"yaml",
	"html",
	"css",
] as const satisfies readonly CodeLanguage[];

const MARKDOWN_CODE_LANGUAGE_ALIASES: Partial<Record<string, CodeLanguage>> = {
	js: "javascript",
	ts: "typescript",
	md: "markdown",
	py: "python",
	rs: "rust",
	sh: "shellscript",
	shell: "shellscript",
	yml: "yaml",
};

const MARKDOWN_CODE_LANGUAGE_SET = new Set<string>([
	...MARKDOWN_CODE_LANGUAGES,
	...Object.keys(MARKDOWN_CODE_LANGUAGE_ALIASES),
]);

function normalizeCodeLanguage(language: string): CodeLanguage | null {
	const normalized = String(language).trim().toLowerCase();
	if (!normalized) return null;
	const alias = MARKDOWN_CODE_LANGUAGE_ALIASES[normalized];
	if (alias) return alias;
	return MARKDOWN_CODE_LANGUAGE_SET.has(normalized)
		? (normalized as CodeLanguage)
		: null;
}

function createPlainHighlightResult(code: string): MarkdownHighlightResult {
	return {
		bg: "transparent",
		fg: "inherit",
		tokens: code.split("\n").map((line) => [
			{
				color: "inherit",
				content: line,
			},
		]),
	};
}

const HIGHLIGHT_CACHE_MAX_ENTRIES = 256;
const HIGHLIGHT_CACHE_MAX_TOTAL_CHARS = 1_000_000;
const HIGHLIGHT_CACHE_MAX_CODE_CHARS = 20_000;
type HighlightCacheEntry = {
	result: MarkdownHighlightResult;
	codeChars: number;
};
const highlightCache = new Map<string, HighlightCacheEntry>();
let highlightCacheChars = 0;

function readHighlightCache(key: string) {
	const cached = highlightCache.get(key);
	if (!cached) return undefined;
	highlightCache.delete(key);
	highlightCache.set(key, cached);
	return cached.result;
}

function writeHighlightCache(
	key: string,
	codeLength: number,
	result: MarkdownHighlightResult,
) {
	highlightCache.set(key, { result, codeChars: codeLength });
	highlightCacheChars += codeLength;
	while (
		highlightCache.size > HIGHLIGHT_CACHE_MAX_ENTRIES ||
		highlightCacheChars > HIGHLIGHT_CACHE_MAX_TOTAL_CHARS
	) {
		const oldestKey = highlightCache.keys().next().value;
		if (oldestKey === undefined) break;
		const oldest = highlightCache.get(oldestKey);
		highlightCache.delete(oldestKey);
		highlightCacheChars = Math.max(
			0,
			highlightCacheChars - (oldest?.codeChars ?? 0),
		);
	}
}

function highlightCode(
	highlighter: ShikiHighlighter,
	options: HighlightOptions,
): MarkdownHighlightResult {
	const language = normalizeCodeLanguage(options.language);
	if (!language) return createPlainHighlightResult(options.code);

	const cacheable = options.code.length <= HIGHLIGHT_CACHE_MAX_CODE_CHARS;
	const cacheKey = `${language}\0${options.code}`;
	if (cacheable) {
		const cached = readHighlightCache(cacheKey);
		if (cached) return cached;
	}

	try {
		const result = highlighter.codeToTokens(options.code, {
			lang: language,
			themes: {
				light: MARKDOWN_CODE_THEMES[0],
				dark: MARKDOWN_CODE_THEMES[1],
			},
		});
		if (cacheable) writeHighlightCache(cacheKey, options.code.length, result);
		return result;
	} catch {
		return createPlainHighlightResult(options.code);
	}
}

function createLazyShikiCodePlugin(): CodeHighlighterPlugin {
	let highlighter: ShikiHighlighter | null = null;

	return {
		name: "shiki",
		type: "code-highlighter",
		getSupportedLanguages: () => [...MARKDOWN_CODE_LANGUAGES],
		getThemes: () => [...MARKDOWN_CODE_THEMES],
		highlight: (options, callback) => {
			const language = normalizeCodeLanguage(options.language);
			if (!language) return createPlainHighlightResult(options.code);
			if (highlighter?.getLoadedLanguages().includes(language)) {
				return highlightCode(highlighter, options);
			}
			void getCodeHighlighter(language)
				.then((loadedHighlighter) => {
					highlighter = loadedHighlighter;
					callback?.(highlightCode(loadedHighlighter, options));
				})
				.catch(() => callback?.(createPlainHighlightResult(options.code)));
			return null;
		},
		supportsLanguage: (language) => normalizeCodeLanguage(language) !== null,
	};
}

export const MARKDOWN_CODE_PLUGIN = createLazyShikiCodePlugin();

export const MARKDOWN_STREAMING_CODE_PLUGIN: CodeHighlighterPlugin = {
	name: "shiki",
	type: "code-highlighter",
	getSupportedLanguages: () => [...MARKDOWN_CODE_LANGUAGES],
	getThemes: () => [...MARKDOWN_CODE_THEMES],
	highlight: (options) => createPlainHighlightResult(options.code),
	supportsLanguage: (language) => normalizeCodeLanguage(language) !== null,
};
