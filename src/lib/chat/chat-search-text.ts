import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import {
	rehypeFileLinks,
	rehypeRelativeFileLinks,
} from "./chat-markdown-links.ts";

const markdownProcessor = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkRehype, { allowDangerousHtml: true })
	.use(rehypeRaw)
	.use(rehypeRelativeFileLinks)
	.use(rehypeSanitize, {
		protocols: {
			...defaultSchema.protocols,
			href: [...(defaultSchema.protocols?.href ?? []), "file"],
		},
	})
	.use(rehypeFileLinks);

export const SEARCH_BLOCK_TAGS = new Set([
	"blockquote",
	"br",
	"div",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"li",
	"p",
	"pre",
	"td",
	"th",
]);

export const SEARCH_IGNORED_TAGS = new Set([
	"button",
	"img",
	"input",
	"script",
	"select",
	"style",
	"svg",
	"textarea",
]);

type SearchTextNode = {
	type: string;
	value?: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: SearchTextNode[];
};

/** Project the same sanitized Markdown content that the message renderer shows. */
export function markdownSearchText(markdown: string): string {
	const tree = markdownProcessor.runSync(markdownProcessor.parse(markdown));
	const parts: string[] = [];
	const visit = (node: SearchTextNode) => {
		if (node.type === "text") {
			parts.push(node.value ?? "");
			return;
		}
		if (
			SEARCH_IGNORED_TAGS.has(node.tagName ?? "") ||
			node.properties?.ariaHidden === true ||
			node.properties?.ariaHidden === "true"
		)
			return;
		const boundary =
			SEARCH_BLOCK_TAGS.has(node.tagName ?? "") ||
			node.properties?.["data-pilo-file-url"] !== undefined;
		if (boundary) parts.push("\n");
		for (const child of node.children ?? []) visit(child);
		if (boundary) parts.push("\n");
	};
	visit(tree);
	return parts.join("").trim();
}

/** Literal, case-insensitive search with equivalent whitespace across DOM nodes. */
export function searchTextMatches(text: string, query: string) {
	const words = query.trim().split(/\s+/);
	if (!words[0]) return [];
	const pattern = words
		.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("\\s+");
	return Array.from(text.matchAll(new RegExp(pattern, "gi")), (match) => ({
		start: match.index,
		end: match.index + match[0].length,
	}));
}
