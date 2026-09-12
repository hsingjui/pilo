import { memo, useMemo, type ComponentPropsWithoutRef } from "react";
import "katex/dist/katex.min.css";
import { createMathPlugin } from "@streamdown/math";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
	Streamdown,
	defaultUrlTransform,
	type CodeHighlighterPlugin,
	type Components,
	type ControlsConfig,
	type HighlightOptions,
	type PluginConfig,
} from "streamdown";
import type { BundledLanguage } from "shiki";

import {
	createMarkdownMermaidConfig,
	createMarkdownMermaidPlugin,
	type MarkdownTheme,
} from "@/components/chat/markdown-mermaid";
import {
	normalizeTexMathDelimiters,
	remarkSingleDollarTextMath,
} from "@/lib/markdown-single-dollar-math";
import { recordMarkdownRender } from "@/lib/chat-performance";
import { useResolvedTheme } from "@/lib/theme-provider";
import { cn } from "@/lib/utils";

type ShikiHighlighter = Awaited<
	ReturnType<(typeof import("shiki/core"))["createHighlighterCore"]>
>;
type MarkdownHighlightResult = NonNullable<
	ReturnType<CodeHighlighterPlugin["highlight"]>
>;

type MarkdownLinkProps = ComponentPropsWithoutRef<"a"> & {
	node?: unknown;
};
type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & {
	node?: unknown;
	inline?: boolean;
};
type MarkdownTableProps = ComponentPropsWithoutRef<"table"> & {
	node?: unknown;
};

const MARKDOWN_CODE_THEME_NAME = "pilo-css-variables";
const MARKDOWN_CODE_THEMES = [
	MARKDOWN_CODE_THEME_NAME,
	MARKDOWN_CODE_THEME_NAME,
] as const;

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
] as const satisfies readonly BundledLanguage[];

const MARKDOWN_CODE_LANGUAGE_ALIASES: Partial<Record<string, BundledLanguage>> =
	{
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

function normalizeCodeLanguage(language: string): BundledLanguage | null {
	const normalized = String(language).trim().toLowerCase();
	if (!normalized) return null;
	const alias = MARKDOWN_CODE_LANGUAGE_ALIASES[normalized];
	if (alias) return alias;
	return MARKDOWN_CODE_LANGUAGE_SET.has(normalized)
		? (normalized as BundledLanguage)
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
const highlightCache = new Map<string, MarkdownHighlightResult>();
let highlightCacheChars = 0;

function readHighlightCache(key: string) {
	const cached = highlightCache.get(key);
	if (!cached) return undefined;
	highlightCache.delete(key);
	highlightCache.set(key, cached);
	return cached;
}

function writeHighlightCache(
	key: string,
	codeLength: number,
	result: MarkdownHighlightResult,
) {
	highlightCache.set(key, result);
	highlightCacheChars += codeLength;
	while (
		highlightCache.size > HIGHLIGHT_CACHE_MAX_ENTRIES ||
		highlightCacheChars > HIGHLIGHT_CACHE_MAX_TOTAL_CHARS
	) {
		const oldestKey = highlightCache.keys().next().value;
		if (oldestKey === undefined) break;
		highlightCache.delete(oldestKey);
		highlightCacheChars = Math.max(0, highlightCacheChars - oldestKey.length);
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
	let highlighterPromise: Promise<ShikiHighlighter> | null = null;

	const loadHighlighter = async () => {
		if (!highlighterPromise) {
			highlighterPromise = (async () => {
				const [
					{ createCssVariablesTheme, createHighlighterCore },
					{ createJavaScriptRegexEngine },
					typescript,
					tsx,
					javascript,
					jsx,
					json,
					bash,
					shellscript,
					markdown,
					python,
					rust,
					go,
					yaml,
					html,
					css,
				] = await Promise.all([
					import("shiki/core"),
					import("shiki/engine/javascript"),
					import("@shikijs/langs/typescript"),
					import("@shikijs/langs/tsx"),
					import("@shikijs/langs/javascript"),
					import("@shikijs/langs/jsx"),
					import("@shikijs/langs/json"),
					import("@shikijs/langs/bash"),
					import("@shikijs/langs/shellscript"),
					import("@shikijs/langs/markdown"),
					import("@shikijs/langs/python"),
					import("@shikijs/langs/rust"),
					import("@shikijs/langs/go"),
					import("@shikijs/langs/yaml"),
					import("@shikijs/langs/html"),
					import("@shikijs/langs/css"),
				]);

				const loadedHighlighter = await createHighlighterCore({
					engine: createJavaScriptRegexEngine(),
					langs: [
						...typescript.default,
						...tsx.default,
						...javascript.default,
						...jsx.default,
						...json.default,
						...bash.default,
						...shellscript.default,
						...markdown.default,
						...python.default,
						...rust.default,
						...go.default,
						...yaml.default,
						...html.default,
						...css.default,
					],
					themes: [
						createCssVariablesTheme({
							name: MARKDOWN_CODE_THEME_NAME,
							variablePrefix: "--pilo-shiki-",
						}),
					],
				});
				highlighter = loadedHighlighter;
				return loadedHighlighter;
			})();
		}
		return highlighterPromise;
	};

	return {
		name: "shiki",
		type: "code-highlighter",
		getSupportedLanguages: () => [...MARKDOWN_CODE_LANGUAGES],
		getThemes: () => [...MARKDOWN_CODE_THEMES],
		highlight: (options, callback) => {
			if (highlighter) return highlightCode(highlighter, options);
			void loadHighlighter()
				.then((loadedHighlighter) =>
					callback?.(highlightCode(loadedHighlighter, options)),
				)
				.catch(() => callback?.(createPlainHighlightResult(options.code)));
			return null;
		},
		supportsLanguage: (language) => normalizeCodeLanguage(language) !== null,
	};
}

const MARKDOWN_CODE_PLUGIN = createLazyShikiCodePlugin();
const MARKDOWN_MATH_PLUGIN = createMathPlugin();
const MARKDOWN_MERMAID_PLUGIN = createMarkdownMermaidPlugin();

const STREAMDOWN_PLUGINS = {
	code: MARKDOWN_CODE_PLUGIN,
	math: MARKDOWN_MATH_PLUGIN,
	mermaid: MARKDOWN_MERMAID_PLUGIN,
} satisfies PluginConfig;

const STREAMDOWN_CONTROLS = {
	code: {
		copy: true,
		download: false,
	},
	mermaid: {
		copy: true,
		download: true,
		fullscreen: false,
		panZoom: false,
	},
	table: false,
} satisfies ControlsConfig;

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkSingleDollarTextMath];
const MARKDOWN_HTML_REHYPE_PLUGINS = [rehypeRaw, rehypeSanitize];
const MARKDOWN_NO_REHYPE_PLUGINS: [] = [];

const MARKDOWN_BASE_CLASSNAME =
	"markdown-renderer max-w-none text-foreground leading-[1.75] " +
	"[&_p]:!mt-0 [&_p]:!mb-3 [&_p:has(+ul)]:!mb-2 [&_p:last-child]:!mb-0 [&_p:first-child]:!mt-0 " +
	"[&_ul]:!my-2 [&_ul]:pl-3 [&_ul]:list-disc " +
	"[&_ul:not(.contains-task-list)]:pl-0 [&_ul:not(.contains-task-list)]:list-none " +
	"[&_ul:not(.contains-task-list)>li]:relative [&_ul:not(.contains-task-list)>li]:pl-6 " +
	"[&_ul:not(.contains-task-list)>li]:before:absolute [&_ul:not(.contains-task-list)>li]:before:left-[10px] [&_ul:not(.contains-task-list)>li]:before:top-[0.75em] [&_ul:not(.contains-task-list)>li]:before:size-1 [&_ul:not(.contains-task-list)>li]:before:-translate-y-1/2 [&_ul:not(.contains-task-list)>li]:before:rounded-full [&_ul:not(.contains-task-list)>li]:before:bg-current [&_ul:not(.contains-task-list)>li]:before:content-[''] " +
	"[&_ol]:!my-2 [&_ol]:pl-0 [&_ol]:list-none [&_ol>li]:relative [&_ol>li]:pl-6 " +
	"[&_ol>li]:before:absolute [&_ol>li]:before:left-0 [&_ol>li]:before:w-[18px] [&_ol>li]:before:whitespace-nowrap [&_ol>li]:before:text-right [&_ol>li]:before:content-[counter(list-item)'.'] " +
	"[&_li]:!my-0 [&_li]:!py-0 [&_li:not(:first-child)]:!mt-2 [&_ul>li:not(:first-child)]:!mt-1 [&_ol>li:not(:first-child)]:!mt-1 [&_li>ul]:!my-1 [&_li>ol]:!my-1 " +
	"[&_blockquote]:!my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:not-italic [&_blockquote]:text-muted-foreground " +
	"[&_hr]:!my-4 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-border " +
	"[&_h1]:!mt-6 [&_h1]:!mb-2 [&_h1]:text-[1.3em] [&_h1]:font-semibold [&_h1]:tracking-tight " +
	"[&_h2]:!mt-5 [&_h2]:!mb-2 [&_h2]:text-[1.15em] [&_h2]:font-semibold [&_h2]:tracking-tight " +
	"[&_h3]:!mt-4 [&_h3]:!mb-2 [&_h3]:text-[1em] [&_h3]:font-semibold " +
	"[&_h4]:!mt-4 [&_h4]:!mb-1.5 [&_h4]:text-[1em] [&_h4]:font-semibold " +
	"[&_h5]:!mt-3 [&_h5]:!mb-1.5 [&_h5]:text-[0.92em] [&_h5]:font-semibold [&_h5]:uppercase [&_h5]:tracking-wide " +
	"[&_h6]:!mt-3 [&_h6]:!mb-1.5 [&_h6]:text-[0.92em] [&_h6]:font-semibold [&_h6]:uppercase [&_h6]:tracking-wide [&_h6]:text-muted-foreground " +
	"[&_:is(h1,h2,h3,h4,h5,h6):first-child]:!mt-0 " +
	"[&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-muted-foreground/40 [&_a:hover]:decoration-muted-foreground " +
	"[&_.katex-display]:!my-5 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1 " +
	"[&_[data-streamdown='mermaid-block']]:!my-5 [&_[data-streamdown='code-block']]:!my-4 " +
	"[&_table]:!my-0 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[0.92em] [&_table]:leading-[1.5] " +
	"[&_th]:border-b [&_th]:border-border/70 [&_th]:bg-muted/45 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_th]:text-foreground/80 " +
	"[&_td]:border-b [&_td]:border-border/45 [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top " +
	"[&_tbody_tr:nth-child(even)]:bg-muted/15 [&_tbody_tr:last-child_td]:border-b-0 " +
	"[&_:is(th,td):first-child]:w-px [&_:is(th,td):first-child]:whitespace-nowrap " +
	"[&_tbody_td:first-child]:font-medium [&_tbody_td:first-child]:text-foreground/75 [&_table_code]:!bg-muted/55 [&_table_code]:!ring-0";

function MarkdownLink({ children, rel, ...props }: MarkdownLinkProps) {
	return (
		<a
			{...props}
			target="_blank"
			rel={`${rel ?? ""} noopener noreferrer`.trim()}
		>
			{children}
		</a>
	);
}

function MarkdownInlineCode({
	className,
	children,
	style: _style,
	node: _node,
	inline: _inline,
	...props
}: MarkdownCodeProps) {
	return (
		<code
			{...props}
			className={cn(
				"rounded-sm bg-code px-1 py-px font-mono text-[0.85em] text-code-foreground ring-1 ring-inset ring-border/50",
				className,
			)}
		>
			{children}
		</code>
	);
}

function MarkdownTable({ node: _node, ...props }: MarkdownTableProps) {
	return (
		<div
			data-markdown-table
			className="scrollbar-pro my-3 overflow-x-auto rounded-lg border border-border/70 bg-background"
		>
			<table {...props} />
		</div>
	);
}

const MARKDOWN_COMPONENTS = {
	a: MarkdownLink,
	inlineCode: MarkdownInlineCode,
	table: MarkdownTable,
} satisfies Components;

export const ChatMarkdown = memo(function ChatMarkdown({
	text,
	isStreaming = false,
	allowHtml = false,
	className,
}: {
	text: string;
	isStreaming?: boolean;
	allowHtml?: boolean;
	className?: string;
}) {
	recordMarkdownRender(text.length);
	const theme: MarkdownTheme = useResolvedTheme();
	const normalizedText = useMemo(
		() => normalizeTexMathDelimiters(text),
		[text],
	);
	const rehypePlugins = allowHtml
		? MARKDOWN_HTML_REHYPE_PLUGINS
		: MARKDOWN_NO_REHYPE_PLUGINS;

	return (
		<div className={cn(MARKDOWN_BASE_CLASSNAME, className)}>
			<Streamdown
				key={`${allowHtml ? "html" : "markdown"}-${theme}`}
				mode="streaming"
				className="space-y-0"
				controls={STREAMDOWN_CONTROLS}
				isAnimating={isStreaming}
				lineNumbers={false}
				mermaid={{ config: createMarkdownMermaidConfig(theme) }}
				plugins={STREAMDOWN_PLUGINS}
				remarkPlugins={MARKDOWN_REMARK_PLUGINS}
				rehypePlugins={rehypePlugins}
				components={MARKDOWN_COMPONENTS}
				translations={{ copied: "已复制", copyCode: "复制代码" }}
				urlTransform={defaultUrlTransform}
			>
				{normalizedText}
			</Streamdown>
		</div>
	);
});
