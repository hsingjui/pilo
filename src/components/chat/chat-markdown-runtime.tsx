import { Component, memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import remarkGfm from "remark-gfm";
import {
	Streamdown,
	defaultUrlTransform,
	type ControlsConfig,
	type PluginConfig,
} from "streamdown";

import {
	MARKDOWN_COMPONENTS,
	MARKDOWN_REHYPE_PLUGINS,
} from "@/components/chat/chat-markdown-components";
import {
	createMarkdownMermaidConfig,
	createMarkdownMermaidPlugin,
} from "@/components/chat/markdown-mermaid";
import {
	MARKDOWN_CODE_PLUGIN,
	MARKDOWN_STREAMING_CODE_PLUGIN,
} from "@/lib/markdown-highlight";
import {
	normalizeTexMathDelimiters,
	remarkSingleDollarTextMath,
} from "@/lib/markdown-single-dollar-math";
import { rehypeMarkdownSourceLines } from "@/lib/markdown-source-lines";
import {
	recordMarkdownParse,
	recordMarkdownRender,
} from "@/lib/chat/chat-performance";
import { createStreamingMarkdownBlockParser } from "@/lib/chat/chat-streaming-markdown";
import { useTheme } from "@/lib/theme-provider";
import { cn } from "@/lib/utils";

const MARKDOWN_MERMAID_PLUGIN = createMarkdownMermaidPlugin();
const MARKDOWN_CATCH_UP_CHUNK_CHARS = 2_000;
const MARKDOWN_CATCH_UP_THRESHOLD_CHARS = 4_000;
const MARKDOWN_CATCH_UP_INTERVAL_MS = 50;
const LONG_STREAMING_MARKDOWN_CHARS = 16_000;
const LONG_STREAMING_MARKDOWN_INTERVAL_MS = 180;
const MAX_ANIMATED_STREAMING_CHARS = 64 * 1024;
type MarkdownMathPlugin = NonNullable<PluginConfig["math"]>;
let cachedMathPlugin: MarkdownMathPlugin | null = null;
let mathPluginPromise: Promise<MarkdownMathPlugin> | null = null;

function loadMarkdownMathPlugin() {
	if (cachedMathPlugin) return Promise.resolve(cachedMathPlugin);
	mathPluginPromise ??= Promise.all([
		import("@streamdown/math"),
		import("katex/dist/katex.min.css"),
	])
		.then(([module]) => {
			cachedMathPlugin = module.createMathPlugin();
			return cachedMathPlugin;
		})
		.catch((error) => {
			mathPluginPromise = null;
			throw error;
		});
	return mathPluginPromise;
}

function hasPotentialMathMarkup(value: string) {
	return value.includes("$") || value.includes("\\(") || value.includes("\\[");
}

function markdownCatchUpSlice(value: string, end: number) {
	let safeEnd = Math.min(value.length, end);
	if (
		safeEnd < value.length &&
		safeEnd > 0 &&
		/[\uD800-\uDBFF]/.test(value[safeEnd - 1])
	) {
		safeEnd += 1;
	}
	return value.slice(0, safeEnd);
}

/**
 * A hidden running session can accumulate tens of thousands of characters while
 * its visual snapshot is frozen. Reconnecting that source in one React commit
 * turns session switching into a multi-second DOM mount. Reveal append-only
 * backlog in bounded chunks. Also coalesce ordinary deltas once the rendered
 * Markdown is long enough for each resize to be expensive.
 */
type MarkdownPresentationBoundaryProps = {
	text: string;
	isStreaming: boolean;
	className?: string;
	sourceLines?: boolean;
};

type MarkdownPresentationBoundaryState = {
	sourceText: string;
	sourceStreaming: boolean;
	presentedText: string;
};

class MarkdownPresentationBoundary extends Component<
	MarkdownPresentationBoundaryProps,
	MarkdownPresentationBoundaryState
> {
	state: MarkdownPresentationBoundaryState = {
		sourceText: this.props.text,
		sourceStreaming: this.props.isStreaming,
		presentedText: this.props.text,
	};

	private timer: number | null = null;
	private lastPresentationCommitAt = Number.NEGATIVE_INFINITY;

	static getDerivedStateFromProps(
		props: MarkdownPresentationBoundaryProps,
		state: MarkdownPresentationBoundaryState,
	): Partial<MarkdownPresentationBoundaryState> | null {
		if (
			props.text === state.sourceText &&
			props.isStreaming === state.sourceStreaming
		)
			return null;

		const finished = state.sourceStreaming && !props.isStreaming;
		const backlogChars = props.text.length - state.presentedText.length;
		const largeBacklog = backlogChars > MARKDOWN_CATCH_UP_THRESHOLD_CHARS;
		const longStream =
			props.isStreaming &&
			state.presentedText.length >= LONG_STREAMING_MARKDOWN_CHARS;
		const deferAppend =
			(largeBacklog ||
				(!finished &&
					(longStream || state.sourceText !== state.presentedText))) &&
			props.text.startsWith(state.presentedText);
		return {
			sourceText: props.text,
			sourceStreaming: props.isStreaming,
			// Flush small final deltas, but keep large background backlogs bounded.
			presentedText: deferAppend ? state.presentedText : props.text,
		};
	}

	componentDidMount() {
		this.lastPresentationCommitAt = performance.now();
		this.schedulePresentation();
	}

	componentDidUpdate(
		_previousProps: MarkdownPresentationBoundaryProps,
		previousState: MarkdownPresentationBoundaryState,
	) {
		if (this.state.presentedText !== previousState.presentedText)
			this.lastPresentationCommitAt = performance.now();
		this.schedulePresentation();
	}

	componentWillUnmount() {
		this.cancelPresentation();
	}

	private cancelPresentation() {
		if (this.timer === null) return;
		window.clearTimeout(this.timer);
		this.timer = null;
	}

	private schedulePresentation() {
		const { presentedText, sourceText } = this.state;
		if (presentedText === sourceText) {
			this.cancelPresentation();
			return;
		}
		if (this.timer !== null) return;

		const interval =
			this.props.isStreaming &&
			presentedText.length >= LONG_STREAMING_MARKDOWN_CHARS &&
			sourceText.length - presentedText.length <=
				MARKDOWN_CATCH_UP_THRESHOLD_CHARS
				? LONG_STREAMING_MARKDOWN_INTERVAL_MS
				: MARKDOWN_CATCH_UP_INTERVAL_MS;
		const delay = Math.max(
			0,
			interval - (performance.now() - this.lastPresentationCommitAt),
		);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.setState((state) => {
				if (state.presentedText === state.sourceText) return null;
				return {
					presentedText: markdownCatchUpSlice(
						state.sourceText,
						state.presentedText.length + MARKDOWN_CATCH_UP_CHUNK_CHARS,
					),
				};
			});
		}, delay);
	}

	render() {
		return (
			<ChatMarkdownBody
				text={this.state.presentedText}
				presentationLagging={
					!this.props.isStreaming &&
					this.state.presentedText !== this.state.sourceText
				}
				isStreaming={this.props.isStreaming}
				className={this.props.className}
				sourceLines={this.props.sourceLines}
			/>
		);
	}
}

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
const MARKDOWN_SOURCE_REHYPE_PLUGINS = [
	...MARKDOWN_REHYPE_PLUGINS,
	rehypeMarkdownSourceLines,
];

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

const ChatMarkdownBody = memo(function ChatMarkdownBody({
	text,
	presentationLagging,
	isStreaming,
	className,
	sourceLines = false,
}: {
	text: string;
	presentationLagging: boolean;
	isStreaming: boolean;
	className?: string;
	sourceLines?: boolean;
}) {
	recordMarkdownRender(text.length);
	const { t } = useTranslation();
	const { resolvedTheme: theme, themeFamily, themeCustomCss } = useTheme();
	const streamingVisual = isStreaming || presentationLagging;
	const needsMath = useMemo(() => hasPotentialMathMarkup(text), [text]);
	const blockParser = useMemo(
		() =>
			sourceLines
				? (markdown: string) => [markdown]
				: createStreamingMarkdownBlockParser({
						onMetrics: recordMarkdownParse,
					}),
		[sourceLines],
	);
	const source = useMemo(
		() => (sourceLines ? normalizeTexMathDelimiters(text) : text),
		[sourceLines, text],
	);
	const [mermaidOptions, setMermaidOptions] = useState(() => ({
		config: createMarkdownMermaidConfig(theme),
	}));
	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- Read the DOM palette after ThemeProvider's layout effects; family and CSS are explicit invalidation triggers even when mode is unchanged. */
	useEffect(() => {
		setMermaidOptions({ config: createMarkdownMermaidConfig(theme) });
	}, [theme, themeFamily, themeCustomCss]);
	/* oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies */
	// Streamdown's memo ignores mermaid options; a new diagram plugin also refreshes existing SVGs.
	const mermaidPlugin = useMemo(
		() => ({
			...MARKDOWN_MERMAID_PLUGIN,
			getMermaid: (config = mermaidOptions.config) =>
				MARKDOWN_MERMAID_PLUGIN.getMermaid(config),
		}),
		[mermaidOptions],
	);
	const [enhanceRichContent, setEnhanceRichContent] = useState(false);
	const [mathPlugin, setMathPlugin] = useState<MarkdownMathPlugin | null>(() =>
		!streamingVisual && needsMath ? cachedMathPlugin : null,
	);

	// Streaming uses only cheap code rendering and treats Mermaid as a code fence.
	// Once the final source is visible, upgrade expensive rendering during idle time
	// so completion and session-switch frames stay bounded.
	useEffect(() => {
		if (streamingVisual || enhanceRichContent) return;
		const idleWindow = window as Window & {
			requestIdleCallback?: (
				callback: () => void,
				options?: { timeout: number },
			) => number;
			cancelIdleCallback?: (handle: number) => void;
		};
		if (idleWindow.requestIdleCallback) {
			const handle = idleWindow.requestIdleCallback(
				() => setEnhanceRichContent(true),
				{ timeout: 1_000 },
			);
			return () => idleWindow.cancelIdleCallback?.(handle);
		}
		const timer = window.setTimeout(() => setEnhanceRichContent(true), 300);
		return () => window.clearTimeout(timer);
	}, [enhanceRichContent, streamingVisual]);

	useEffect(() => {
		if (streamingVisual || !needsMath || mathPlugin) return;
		let cancelled = false;
		void loadMarkdownMathPlugin()
			.then((plugin) => {
				if (!cancelled) setMathPlugin(plugin);
			})
			.catch((error) => {
				console.warn("Failed to load Markdown math renderer", error);
			});
		return () => {
			cancelled = true;
		};
	}, [mathPlugin, needsMath, streamingVisual]);

	const plugins = useMemo(
		() =>
			({
				code:
					!streamingVisual && enhanceRichContent
						? MARKDOWN_CODE_PLUGIN
						: MARKDOWN_STREAMING_CODE_PLUGIN,
				...(!streamingVisual && enhanceRichContent
					? { mermaid: mermaidPlugin }
					: {}),
				...(!streamingVisual && needsMath && mathPlugin
					? { math: mathPlugin }
					: {}),
			}) satisfies PluginConfig,
		[enhanceRichContent, mathPlugin, mermaidPlugin, needsMath, streamingVisual],
	);
	const shouldAnimate =
		isStreaming && text.length < MAX_ANIMATED_STREAMING_CHARS;

	return (
		<div className={cn(MARKDOWN_BASE_CLASSNAME, className)}>
			<Streamdown
				mode={sourceLines ? "static" : "streaming"}
				className="space-y-0"
				controls={STREAMDOWN_CONTROLS}
				isAnimating={shouldAnimate}
				lineNumbers={false}
				mermaid={mermaidOptions}
				parseIncompleteMarkdown={false}
				parseMarkdownIntoBlocksFn={blockParser}
				plugins={plugins}
				remarkPlugins={MARKDOWN_REMARK_PLUGINS}
				rehypePlugins={
					sourceLines ? MARKDOWN_SOURCE_REHYPE_PLUGINS : MARKDOWN_REHYPE_PLUGINS
				}
				components={MARKDOWN_COMPONENTS}
				translations={{
					copied: t("chat.copied"),
					copyCode: t("chat.copyCode"),
				}}
				urlTransform={defaultUrlTransform}
			>
				{source}
			</Streamdown>
		</div>
	);
});

export const ChatMarkdown = memo(function ChatMarkdown({
	text,
	isStreaming = false,
	className,
	sourceLines,
}: {
	text: string;
	isStreaming?: boolean;
	className?: string;
	sourceLines?: boolean;
}) {
	return (
		<MarkdownPresentationBoundary
			text={text}
			isStreaming={isStreaming}
			className={className}
			sourceLines={sourceLines}
		/>
	);
});
