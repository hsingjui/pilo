/**
 * 会话内查找的字符级高亮，基于 CSS Custom Highlight API。
 * 不改 Markdown 渲染管线、不产生额外 DOM 节点，虚拟列表里的已挂载行才生效。
 */

const ALL_HIGHLIGHT = "pilo-find";
const ACTIVE_HIGHLIGHT = "pilo-find-active";

type HighlightApi = {
	highlights: {
		set(name: string, highlight: unknown): void;
		delete(name: string): void;
	};
	Highlight: new (...ranges: Range[]) => unknown;
};

function highlightApi(): HighlightApi | null {
	if (typeof CSS === "undefined") return null;
	const css = CSS as unknown as Partial<HighlightApi>;
	if (!css.highlights || typeof css.Highlight !== "function") return null;
	return css as HighlightApi;
}

export function clearTextHighlight(): void {
	const api = highlightApi();
	api?.highlights.delete(ALL_HIGHLIGHT);
	api?.highlights.delete(ACTIVE_HIGHLIGHT);
}

/** 收集某个消息元素内 needle 的全部命中区间（同一文本节点内的连续匹配）。 */
function matchRangesInElement(element: Element, needle: string): Range[] {
	const ranges: Range[] = [];
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode();
	while (node) {
		const text = node.nodeValue ?? "";
		const lower = text.toLowerCase();
		let at = lower.indexOf(needle);
		while (at >= 0) {
			const range = document.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + needle.length);
			ranges.push(range);
			at = lower.indexOf(needle, at + needle.length);
		}
		node = walker.nextNode();
	}
	return ranges;
}

/**
 * 在 `container` 内按 `query` 重算高亮：全部命中弱高亮，active 命中强高亮。
 * `active` 以「消息 id + 该消息内第几个命中」定位，与模型层匹配序号对齐。
 * 返回 active 命中是否已在 DOM 中找到（供调用方决定是否重试）。
 */
export function applyTextHighlight(
	container: ParentNode,
	query: string,
	active?: { messageId: string; occurrenceIndex: number },
): boolean {
	const api = highlightApi();
	if (!api) return false;
	api.highlights.delete(ALL_HIGHLIGHT);
	api.highlights.delete(ACTIVE_HIGHLIGHT);
	const needle = query.trim().toLowerCase();
	if (!needle) return false;

	const all: Range[] = [];
	let activeRange: Range | undefined;
	for (const element of container.querySelectorAll("[data-message-id]")) {
		const ranges = matchRangesInElement(element, needle);
		all.push(...ranges);
		if (
			active &&
			element.getAttribute("data-message-id") === active.messageId &&
			ranges[active.occurrenceIndex]
		) {
			activeRange = ranges[active.occurrenceIndex];
		}
	}
	if (all.length > 0)
		api.highlights.set(ALL_HIGHLIGHT, new api.Highlight(...all));
	if (activeRange) {
		api.highlights.set(ACTIVE_HIGHLIGHT, new api.Highlight(activeRange));
	}
	return Boolean(activeRange);
}
