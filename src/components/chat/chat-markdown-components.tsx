import type { ComponentPropsWithoutRef } from "react";
import type { Components } from "streamdown";
import { cn } from "@/lib/utils";

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
				"rounded-sm bg-code px-1 py-px font-mono [font-size:var(--pilo-code-font-size)] text-code-foreground ring-1 ring-inset ring-border/50",
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

export const MARKDOWN_COMPONENTS = {
	a: MarkdownLink,
	inlineCode: MarkdownInlineCode,
	table: MarkdownTable,
} satisfies Components;
