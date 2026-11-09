type SourceNode = {
	type: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: SourceNode[];
	position?: { start: { line: number }; end: { line: number } };
};

const SOURCE_BLOCK_TAGS = new Set([
	"p",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"li",
	"blockquote",
	"pre",
	"table",
	"th",
	"td",
	"hr",
]);

/** Preview-only: run after sanitization on a whole, line-preserving document. */
export function rehypeMarkdownSourceLines() {
	return function visit(node: SourceNode) {
		for (const child of node.children ?? []) visit(child);
		if (!node.tagName || !SOURCE_BLOCK_TAGS.has(node.tagName) || !node.position)
			return;
		const properties = {
			"data-source-line-start": node.position.start.line,
			"data-source-line-end": node.position.end.line,
		};
		if (node.tagName === "pre") {
			// Streamdown replaces <pre> with its code/math renderer and drops its props.
			const pre = { ...node };
			node.tagName = "div";
			node.properties = properties;
			node.children = [pre];
		} else {
			node.properties = { ...node.properties, ...properties };
		}
	};
}
