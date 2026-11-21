const PROSE_SELECTOR = "p, li, th, td, h1, h2, h3, h4, h5, h6";
const NATIVE_SELECTION_SELECTOR =
	"input, textarea, [contenteditable], pre, button, [role='button'], .xterm";

/** Keep native paragraph selection, but exclude block boundaries from its paint. */
export function tightenTripleClickSelection(event: MouseEvent): void {
	if (
		event.detail !== 3 ||
		event.button !== 0 ||
		event.defaultPrevented ||
		event.shiftKey ||
		event.ctrlKey ||
		event.altKey ||
		event.metaKey
	)
		return;

	const target = event.target;
	if (
		!(target instanceof Element) ||
		!target.closest(PROSE_SELECTOR) ||
		target.closest(NATIVE_SELECTION_SELECTOR)
	)
		return;

	const document = target.ownerDocument;
	// Let the native mousedown select its paragraph, then tighten before paint.
	document.defaultView?.requestAnimationFrame(() => {
		if (!event.defaultPrevented && target.isConnected)
			tightenSelection(document);
	});
}

function tightenSelection(document: Document): void {
	const selection = document.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;

	const range = selection.getRangeAt(0);
	const startElement =
		range.startContainer instanceof Element
			? range.startContainer
			: range.startContainer.parentElement;
	const endElement =
		range.endContainer instanceof Element
			? range.endContainer
			: range.endContainer.parentElement;
	if (
		startElement?.closest(NATIVE_SELECTION_SELECTOR) ||
		endElement?.closest(NATIVE_SELECTION_SELECTOR)
	)
		return;

	const root = range.commonAncestorContainer;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let node = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode();
	let first: { node: Node; offset: number } | null = null;
	let last: { node: Node; offset: number } | null = null;
	while (node) {
		if (range.intersectsNode(node)) {
			const text = node.nodeValue ?? "";
			const start = node === range.startContainer ? range.startOffset : 0;
			const end = node === range.endContainer ? range.endOffset : text.length;
			if (text.slice(start, end).trim()) {
				first ??= { node, offset: start };
				last = { node, offset: end };
			}
		}
		node = walker.nextNode();
	}
	if (!first || !last) return;

	const forward =
		selection.anchorNode === range.startContainer &&
		selection.anchorOffset === range.startOffset;
	const anchor = forward ? first : last;
	const focus = forward ? last : first;
	// Reapply text endpoints instead of native paragraph/block boundaries.
	selection.setBaseAndExtent(
		anchor.node,
		anchor.offset,
		focus.node,
		focus.offset,
	);
}
