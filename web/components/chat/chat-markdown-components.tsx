import {
	cloneElement,
	isValidElement,
	useContext,
	useId,
	type ComponentPropsWithoutRef,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { PluggableList, Plugin } from "unified";
import type { Options as SanitizeSchema } from "rehype-sanitize";
import { defaultRehypePlugins, type Components } from "streamdown";
import { rehypeProjectImages } from "@shared/chat/chat-markdown-images";
import { MarkdownImage } from "@/components/chat/chat-markdown-image";
import {
	MarkdownLink,
	MarkdownLinkLabelContext,
} from "@/components/chat/chat-markdown-link";
import {
	rehypeFileLinks,
	rehypeRelativeFileLinks,
} from "@shared/chat/chat-markdown-links";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/copy-text";

type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & {
	node?: unknown;
	inline?: boolean;
	"data-block"?: string;
};
type MarkdownPreProps = ComponentPropsWithoutRef<"pre"> & {
	node?: unknown;
};
type MarkdownTableProps = ComponentPropsWithoutRef<"table"> & {
	node?: unknown;
};

function MarkdownPre({ children }: MarkdownPreProps) {
	const { t } = useTranslation();
	if (!isValidElement<MarkdownCodeProps>(children)) return children;

	// Keep Streamdown's block rendering and replace only the unavailable copy action.
	const block = cloneElement(children, { "data-block": "true" });
	const text = children.props.children;
	if (
		typeof text !== "string" ||
		typeof globalThis.navigator?.clipboard?.writeText === "function"
	)
		return block;

	return (
		<div
			className="contents"
			onClickCapture={(event) => {
				if (
					!(event.target instanceof Element) ||
					!event.target.closest(
						'button[data-streamdown="code-block-copy-button"]:enabled',
					)
				)
					return;
				event.stopPropagation();
				void copyText(text).then(
					() => toast.success(t("chat.copied")),
					() => toast.error(t("chat.copyFailed")),
				);
			}}
		>
			{block}
		</div>
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
	const { t } = useTranslation();
	const isLinkLabel = useContext(MarkdownLinkLabelContext);
	const copyDescriptionId = useId();
	const codeClassName = cn(
		"rounded-sm bg-code px-1 py-px font-mono [font-size:var(--pilo-code-font-size)] text-code-foreground ring-1 ring-inset ring-border/50",
		className,
	);

	if (isLinkLabel) {
		return (
			<code {...props} className={codeClassName}>
				{children}
			</code>
		);
	}

	async function copyCode(element: HTMLElement) {
		const selection = window.getSelection();
		if (
			selection &&
			!selection.isCollapsed &&
			selection.containsNode(element, true)
		)
			return;
		try {
			await copyText(element.textContent ?? "");
			toast.success(t("chat.copied"));
		} catch {
			toast.error(t("chat.copyFailed"));
		}
	}

	/* oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role -- Keep code inline; native buttons change wrapping. Keyboard activation and focus are provided explicitly. */
	return (
		<>
			<code
				{...props}
				role="button"
				tabIndex={0}
				aria-describedby={copyDescriptionId}
				className={cn(
					"cursor-pointer hover:bg-hover focus-visible:outline-hidden focus-visible:ring-ring",
					codeClassName,
				)}
				onClick={(event) => void copyCode(event.currentTarget)}
				onKeyDown={(event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					if (!event.repeat) void copyCode(event.currentTarget);
				}}
			>
				{children}
			</code>
			<span id={copyDescriptionId} hidden>
				{t("chat.copyCode")}
			</span>
		</>
	);
	/* oxlint-enable jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role */
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

// Streamdown exposes this configured tuple only as the wider Pluggable type.
const [sanitize, sanitizeSchema] = defaultRehypePlugins.sanitize as [
	Plugin<[SanitizeSchema]>,
	SanitizeSchema,
];

export const MARKDOWN_REHYPE_PLUGINS = [
	defaultRehypePlugins.raw,
	rehypeRelativeFileLinks,
	[
		sanitize,
		{
			...sanitizeSchema,
			protocols: {
				...sanitizeSchema.protocols,
				href: [...(sanitizeSchema.protocols?.href ?? []), "file"],
			},
		},
	],
	rehypeFileLinks,
	rehypeProjectImages,
	defaultRehypePlugins.harden,
] satisfies PluggableList;

export const MARKDOWN_COMPONENTS = {
	a: MarkdownLink,
	img: MarkdownImage,
	inlineCode: MarkdownInlineCode,
	pre: MarkdownPre,
	table: MarkdownTable,
} satisfies Components;
