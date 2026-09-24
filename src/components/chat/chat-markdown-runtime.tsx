import { Component, memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import remarkGfm from "remark-gfm";
import {
	Streamdown,
	defaultUrlTransform,
	type ControlsConfig,
	type PluginConfig,
} from "streamdown";

import { MARKDOWN_COMPONENTS } from "@/components/chat/chat-markdown-components";
import {
	createMarkdownMermaidConfig,
	createMarkdownMermaidPlugin,
	type MarkdownTheme,
} from "@/components/chat/markdown-mermaid";
import {
	MARKDOWN_CODE_PLUGIN,
	MARKDOWN_STREAMING_CODE_PLUGIN,
} from "@/lib/markdown-highlight";
import { remarkSingleDollarTextMath } from "@/lib/markdown-single-dollar-math";
import {
	recordMarkdownParse,
	recordMarkdownRender,
} from "@/lib/chat-performance";
import { createStreamingMarkdownBlockParser } from "@/lib/chat-streaming-markdown";
import { useResolvedTheme } from "@/lib/theme-provider";
import { cn } from "@/lib/utils";

const MARKDOWN_MERMAID_PLUGIN = createMarkdownMermaidPlugin();
const MARKDOWN_CATCH_UP_CHUNK_CHARS = 2_000;
const MARKDOWN_CATCH_UP_THRESHOLD_CHARS = 4_000;
const MARKDOWN_CATCH_UP_INTERVAL_MS = 50;
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
 * turns session switching into a multi-second DOM mount. Reveal the append-only
 * backlog in bounded animation-frame chunks instead; ordinary streaming deltas
 * are normally smaller than one chunk and incur only a single-frame handoff.
 */
type MarkdownPresentationBoundaryProps = {
	text: string;
	isStreaming: boolean;
	className?: string;
};

type MarkdownPresentationBoundaryState = {
	sourceText: string;
	presentedText: string;
	catchingUp: boolean;
};

class MarkdownPresentationBoundary extends Component<
	MarkdownPresentationBoundaryProps,
	MarkdownPresentationBoundaryState
> {
	state: MarkdownPresentationBoundaryState = {
		sourceText: this.props.text,
		presentedText: this.props.text,
		catchingUp: false,
	};

	private frame: number | null = null;
	private lastCatchUpCommitAt = Number.NEGATIVE_INFINITY;

	static getDerivedStateFromProps(
		props: MarkdownPresentationBoundaryProps,
		state: MarkdownPresentationBoundaryState,
	): Partial<MarkdownPresentationBoundaryState> | null {
		if (props.text === state.sourceText) return null;
		if (state.catchingUp) {
			if (props.text.startsWith(state.presentedText)) {
				return { sourceText: props.text };
			}
			return {
				sourceText: props.text,
				presentedText: props.text,
				catchingUp: false,
			};
		}

		const appendOnly = props.text.startsWith(state.sourceText);
		const backlogChars = props.text.length - state.sourceText.length;
		if (appendOnly && backlogChars > MARKDOWN_CATCH_UP_THRESHOLD_CHARS) {
			return {
				sourceText: props.text,
				presentedText: state.sourceText,
				catchingUp: true,
			};
		}
		return {
			sourceText: props.text,
			presentedText: props.text,
			catchingUp: false,
		};
	}

	componentDidMount() {
		this.scheduleCatchUp();
	}

	componentDidUpdate() {
		this.scheduleCatchUp();
	}

	componentWillUnmount() {
		if (this.frame !== null) cancelAnimationFrame(this.frame);
	}

	private scheduleCatchUp() {
		if (!this.state.catchingUp) {
			if (this.frame !== null) {
				cancelAnimationFrame(this.frame);
				this.frame = null;
			}
			this.lastCatchUpCommitAt = Number.NEGATIVE_INFINITY;
			return;
		}
		if (this.frame !== null) return;

		// Backlog reveal is presentation work too. Advancing on every animation
		// frame can drive a growing Virtua row through synchronous ResizeObserver
		// measurement at ~60 Hz, which is faster than normal active streaming.
		// Keep the first chunk responsive, then cap subsequent catch-up commits at
		// the fastest normal presentation cadence (20 fps).
		const advance = (timestamp: number) => {
			if (!this.state.catchingUp) {
				this.frame = null;
				this.lastCatchUpCommitAt = Number.NEGATIVE_INFINITY;
				return;
			}
			if (
				timestamp - this.lastCatchUpCommitAt <
				MARKDOWN_CATCH_UP_INTERVAL_MS
			) {
				this.frame = requestAnimationFrame(advance);
				return;
			}

			this.frame = null;
			this.lastCatchUpCommitAt = timestamp;
			this.setState((state) => {
				const sourceText = this.props.text;
				if (!sourceText.startsWith(state.presentedText)) {
					return {
						sourceText,
						presentedText: sourceText,
						catchingUp: false,
					};
				}
				const presentedText = markdownCatchUpSlice(
					sourceText,
					state.presentedText.length + MARKDOWN_CATCH_UP_CHUNK_CHARS,
				);
				return {
					sourceText,
					presentedText,
					catchingUp: presentedText !== sourceText,
				};
			});
		};

		this.frame = requestAnimationFrame(advance);
	}

	render() {
		return (
			<ChatMarkdownBody
				text={this.state.presentedText}
				presentationLagging={this.state.catchingUp}
				isStreaming={this.props.isStreaming}
				className={this.props.className}
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
}: {
	text: string;
	presentationLagging: boolean;
	isStreaming: boolean;
	className?: string;
}) {
	recordMarkdownRender(text.length);
	const { t } = useTranslation();
	const theme: MarkdownTheme = useResolvedTheme();
	const streamingVisual = isStreaming || presentationLagging;
	const needsMath = useMemo(() => hasPotentialMathMarkup(text), [text]);
	const blockParser = useMemo(
		() =>
			createStreamingMarkdownBlockParser({ onMetrics: recordMarkdownParse }),
		[],
	);
	const mermaidOptions = useMemo(
		() => ({ config: createMarkdownMermaidConfig(theme) }),
		[theme],
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
					? { mermaid: MARKDOWN_MERMAID_PLUGIN }
					: {}),
				...(!streamingVisual && needsMath && mathPlugin
					? { math: mathPlugin }
					: {}),
			}) satisfies PluginConfig,
		[enhanceRichContent, mathPlugin, needsMath, streamingVisual],
	);
	const shouldAnimate =
		isStreaming && text.length < MAX_ANIMATED_STREAMING_CHARS;

	return (
		<div className={cn(MARKDOWN_BASE_CLASSNAME, className)}>
			<Streamdown
				mode="streaming"
				className="space-y-0"
				controls={STREAMDOWN_CONTROLS}
				isAnimating={shouldAnimate}
				lineNumbers={false}
				mermaid={mermaidOptions}
				parseIncompleteMarkdown={false}
				parseMarkdownIntoBlocksFn={blockParser}
				plugins={plugins}
				remarkPlugins={MARKDOWN_REMARK_PLUGINS}
				components={MARKDOWN_COMPONENTS}
				translations={{
					copied: t("chat.copied"),
					copyCode: t("chat.copyCode"),
				}}
				urlTransform={defaultUrlTransform}
			>
				{text}
			</Streamdown>
		</div>
	);
});

export const ChatMarkdown = memo(function ChatMarkdown({
	text,
	isStreaming = false,
	className,
}: {
	text: string;
	isStreaming?: boolean;
	className?: string;
}) {
	return (
		<MarkdownPresentationBoundary
			text={text}
			isStreaming={isStreaming}
			className={className}
		/>
	);
});
