import type {
	RichNodeJSON,
	RichRange,
	RichSelectionJSON,
	RichSliceJSON,
} from "nsh/base";

import {
	fileMentionName,
	fileMentionValue,
	readChatMentionParts,
	type ChatMention,
} from "@shared/chat/chat-mentions";
import {
	formatChatImageSize,
	type ChatImageAttachment,
} from "@shared/chat/chat-submission";
import type { ActiveSuggestionQuery } from "@shared/chat/composer-suggestions";
import {
	sessionMentionValue,
	type SessionMention,
} from "@shared/chat/session-mentions";

export const CHAT_MENTION_NODE_TYPE = "chatMention";

export type ChatMentionNodeAttrs = {
	kind: "file" | "session" | "image";
	path: string;
	label: string;
	detail: string;
	raw: string;
};

/** 构造一条内联 file/session 原子节点的 ProseMirror JSON。 */
export function createMentionNode(mention: ChatMention): RichNodeJSON {
	const attrs: ChatMentionNodeAttrs =
		mention.kind === "session"
			? {
					kind: "session",
					path: mention.path,
					label: mention.session.title,
					detail: mention.session.projectName,
					raw: sessionMentionValue(mention.path),
				}
			: {
					kind: "file",
					path: mention.path,
					label: fileMentionName(mention.path),
					detail: "",
					raw: fileMentionValue(mention.path),
				};
	return {
		type: CHAT_MENTION_NODE_TYPE,
		attrs,
	};
}

/** 构造一条内联上传图片原子节点的 ProseMirror JSON（序列化为纯文本时为空，不污染提交正文）。 */
export function createImageMentionNode(
	image: Pick<ChatImageAttachment, "id" | "name" | "size">,
): RichNodeJSON {
	const attrs: ChatMentionNodeAttrs = {
		kind: "image",
		path: image.id,
		label: image.name,
		detail: formatChatImageSize(image.size),
		raw: "",
	};
	return {
		type: CHAT_MENTION_NODE_TYPE,
		attrs,
	};
}

/** 将纯文本草稿与图片列表解析为 `RichEditor` 文档 JSON。 */
export function valueToRichDoc(
	value: string,
	sessions: ReadonlyMap<string, SessionMention>,
	images: readonly Pick<ChatImageAttachment, "id" | "name" | "size">[] = [],
	imageOffsets?: ReadonlyMap<string, number>,
): RichNodeJSON {
	const placements = images
		.map((image) => ({
			image,
			offset: Math.min(
				imageOffsets?.get(image.id) ?? value.length,
				value.length,
			),
		}))
		.sort((a, b) => a.offset - b.offset);
	let nextImage = 0;
	let offset = 0;
	const paragraphs: RichNodeJSON[] = value.split("\n").map((line) => {
		const content: RichNodeJSON[] = [];
		const appendText = (text: string) => {
			if (text) content.push({ type: "text", text });
		};
		const appendImage = () => {
			content.push(createImageMentionNode(placements[nextImage++]!.image));
		};
		for (const part of readChatMentionParts(line, sessions)) {
			const end = offset + part.value.length;
			let start = offset;
			while (
				nextImage < placements.length &&
				placements[nextImage]!.offset < end
			) {
				const at = Math.max(start, placements[nextImage]!.offset);
				if (!part.mention)
					appendText(part.value.slice(start - offset, at - offset));
				appendImage();
				start = at;
			}
			if (part.mention) content.push(createMentionNode(part.mention));
			else appendText(part.value.slice(start - offset));
			offset = end;
		}
		while (
			nextImage < placements.length &&
			placements[nextImage]!.offset <= offset
		)
			appendImage();
		offset += 1; // newline between paragraphs
		return content.length
			? { type: "paragraph", content }
			: { type: "paragraph" };
	});
	return { type: "doc", content: paragraphs };
}

function serializeInline(
	nodes: readonly RichNodeJSON[] | undefined,
	imageReference?: (id: string) => string,
): string {
	let out = "";
	let afterImage = false;
	for (const node of nodes ?? []) {
		let text = "";
		let isImage = false;
		if (node.type === "text") {
			text = node.text ?? "";
		} else if (node.type === CHAT_MENTION_NODE_TYPE) {
			const attrs = node.attrs;
			if (attrs?.kind === "image" && typeof attrs.path === "string") {
				isImage = true;
				text = imageReference?.(attrs.path) ?? "";
			} else if (typeof attrs?.raw === "string") {
				text = attrs.raw;
			}
		} else if (node.type === "hardBreak") {
			text = "\n";
		} else if (node.content?.length) {
			text = serializeInline(node.content, imageReference);
		}
		if (!text) continue;
		if ((afterImage || isImage) && out && !/\s$/.test(out) && !/^\s/.test(text))
			out += " ";
		out += text;
		afterImage = isImage;
	}
	return out;
}

/** 块之间换行，块内的富文本 runs 和 mention 保持相连。 */
export function sliceToPlainText(slice: RichSliceJSON): string {
	const blocks: string[] = [];
	let inline: RichNodeJSON[] = [];
	for (const node of slice.content ?? []) {
		if (
			node.type === "text" ||
			node.type === CHAT_MENTION_NODE_TYPE ||
			node.type === "hardBreak"
		) {
			inline.push(node);
			continue;
		}
		if (inline.length) blocks.push(serializeInline(inline));
		inline = [];
		blocks.push(sliceToPlainText({ content: node.content }));
	}
	if (inline.length) blocks.push(serializeInline(inline));
	return blocks.join("\n");
}

/** 图片在纯文本中的零宽位置；编辑器重建后仍可放回原处。 */
export function richDocImageOffsets(doc: RichNodeJSON): Map<string, number> {
	const offsets = new Map<string, number>();
	let offset = 0;
	for (const block of doc.content ?? []) {
		for (const child of block.content ?? []) {
			if (
				child.type === CHAT_MENTION_NODE_TYPE &&
				child.attrs?.kind === "image" &&
				typeof child.attrs.path === "string"
			) {
				offsets.set(child.attrs.path, offset);
			} else {
				offset += serializeInline([child]).length;
			}
		}
		offset += 1;
	}
	return offsets;
}

/** Keep anchors in the unchanged prefix/suffix when a plain-text draft is replaced. */
export function remapRichImageOffsets(
	previous: string,
	next: string,
	offsets: Map<string, number>,
): Map<string, number> {
	if (previous === next || offsets.size === 0) return offsets;
	let start = 0;
	let oldEnd = previous.length;
	let newEnd = next.length;
	while (start < oldEnd && start < newEnd && previous[start] === next[start])
		start++;
	while (
		oldEnd > start &&
		newEnd > start &&
		previous[oldEnd - 1] === next[newEnd - 1]
	) {
		oldEnd--;
		newEnd--;
	}
	return new Map(
		[...offsets].map(([id, at]) => {
			let mapped =
				at <= start ? at : at >= oldEnd ? at + newEnd - oldEnd : start;
			// A shared UTF-16 prefix can end in the middle of a changed emoji.
			const unit = next.charCodeAt(mapped);
			if (unit >= 0xdc00 && unit <= 0xdfff) mapped--;
			return [id, mapped];
		}),
	);
}

/** 将文档序列化为草稿纯文本；仅在发送时传入图片引用。 */
export function richDocToValue(
	doc: RichNodeJSON | null | undefined,
	imageReference?: (id: string) => string,
): string {
	const blocks = doc?.content;
	if (!blocks?.length) return "";
	return blocks
		.map((block) => serializeInline(block.content, imageReference))
		.join("\n");
}

/** 收集文档中当前存在的全部内联图片节点 ID（保持文档顺序）。 */
export function richDocImageIds(
	doc: RichNodeJSON | null | undefined,
): string[] {
	const ids: string[] = [];
	for (const block of doc?.content ?? []) {
		for (const child of block.content ?? []) {
			if (
				child.type === CHAT_MENTION_NODE_TYPE &&
				child.attrs?.kind === "image" &&
				typeof child.attrs.path === "string"
			) {
				ids.push(child.attrs.path);
			}
		}
	}
	return ids;
}

/**
 * 构造在文档 `pos` 处插入内联图片所需的节点序列：
 * - 若插入点紧贴前文内容/引用，则补一个前导空格；
 * - 连续多张图片之间以单个空格分隔；
 * - 若插入点在段尾或紧贴后续非空白内容，则补一个尾随空格，便于继续粘贴或输入。
 */
export function buildRichImageInsertNodes(
	doc: RichNodeJSON | null | undefined,
	pos: number,
	images: readonly Pick<ChatImageAttachment, "id" | "name" | "size">[],
): RichNodeJSON[] {
	if (images.length === 0) return [];
	let beforeKind: "none" | "space" | "content" = "none";
	let afterKind: "none" | "space" | "content" = "none";

	let cursor = 0;
	for (const block of doc?.content ?? []) {
		const blockStart = cursor + 1;
		const children = block.content ?? [];
		const blockLen = children.reduce(
			(sum, child) => sum + inlineNodeSize(child),
			0,
		);
		const blockEnd = blockStart + blockLen;
		if (pos >= blockStart && pos <= blockEnd) {
			let childPos = blockStart;
			for (const child of children) {
				const size = inlineNodeSize(child);
				const childEnd = childPos + size;
				if (childPos < pos && pos <= childEnd) {
					if (child.type === "text") {
						const ch = (child.text ?? "")[pos - childPos - 1] ?? "";
						beforeKind = /\s/.test(ch) ? "space" : "content";
					} else if (child.type === "hardBreak") {
						beforeKind = "space";
					} else {
						beforeKind = "content";
					}
				}
				if (childPos <= pos && pos < childEnd) {
					if (child.type === "text") {
						const ch = (child.text ?? "")[pos - childPos] ?? "";
						afterKind = /\s/.test(ch) ? "space" : "content";
					} else if (child.type === "hardBreak") {
						afterKind = "space";
					} else {
						afterKind = "content";
					}
				}
				childPos = childEnd;
			}
			break;
		}
		cursor = blockEnd + 1;
	}

	const nodes: RichNodeJSON[] = [];
	if (beforeKind === "content") nodes.push({ type: "text", text: " " });
	for (let i = 0; i < images.length; i++) {
		if (i > 0) nodes.push({ type: "text", text: " " });
		nodes.push(createImageMentionNode(images[i]!));
	}
	if (afterKind !== "space") nodes.push({ type: "text", text: " " });
	return nodes;
}

/** 计算待移除内联图片节点在文档中的精确位置范围。 */
export function findRichImageNodeRanges(
	doc: RichNodeJSON | null | undefined,
	removeIds: ReadonlySet<string>,
): RichRange[] {
	const ranges: RichRange[] = [];
	let pos = 0;
	for (const block of doc?.content ?? []) {
		pos += 1; // paragraph start
		for (const child of block.content ?? []) {
			const size = inlineNodeSize(child);
			if (
				child.type === CHAT_MENTION_NODE_TYPE &&
				child.attrs?.kind === "image" &&
				typeof child.attrs.path === "string" &&
				removeIds.has(child.attrs.path)
			) {
				ranges.push({ from: pos, to: pos + size });
			}
			pos += size;
		}
		pos += 1; // paragraph end
	}
	return ranges;
}

type ParagraphSlot = "remove" | "space" | "whitespace" | "content";

/**
 * 计算从文档移除内联图片时的删除范围，并顺带清理归属于被移除图片的单个分隔空格，
 * 同时保证不会把原本由空格隔开的相邻正文或引用粘连到一起。
 */
export function findRichImageRemovalRanges(
	doc: RichNodeJSON | null | undefined,
	removeIds: ReadonlySet<string>,
): RichRange[] {
	if (removeIds.size === 0) return [];
	const ranges: RichRange[] = [];
	let pos = 0;
	for (const block of doc?.content ?? []) {
		const blockStart = pos + 1;
		const slots: ParagraphSlot[] = [];
		let hasRemove = false;
		for (const child of block.content ?? []) {
			if (child.type === "text") {
				const text = child.text ?? "";
				// Editor positions count UTF-16 code units, including both halves of a surrogate pair.
				for (let i = 0; i < text.length; i++) {
					const ch = text.charAt(i);
					slots.push(
						ch === " " ? "space" : /\s/.test(ch) ? "whitespace" : "content",
					);
				}
			} else if (child.type === "hardBreak") {
				slots.push("whitespace");
			} else if (
				child.type === CHAT_MENTION_NODE_TYPE &&
				child.attrs?.kind === "image" &&
				typeof child.attrs.path === "string" &&
				removeIds.has(child.attrs.path)
			) {
				slots.push("remove");
				hasRemove = true;
			} else {
				slots.push("content");
			}
		}
		if (hasRemove) {
			const drop = slots.map((slot) => slot === "remove");
			const prevKept = (from: number) => {
				for (let j = from; j >= 0; j--) {
					if (!drop[j]) return j;
				}
				return -1;
			};
			const nextKept = (from: number) => {
				for (let j = from; j < slots.length; j++) {
					if (!drop[j]) return j;
				}
				return -1;
			};
			for (let i = 0; i < slots.length; i++) {
				if (slots[i] !== "remove") continue;
				const leftIdx = prevKept(i - 1);
				const leftKind = leftIdx >= 0 ? slots[leftIdx]! : "none";
				const rightImmediate = i + 1;
				if (
					rightImmediate < slots.length &&
					!drop[rightImmediate] &&
					slots[rightImmediate] === "space"
				) {
					const afterSpaceIdx = nextKept(rightImmediate + 1);
					const afterSpaceKind =
						afterSpaceIdx >= 0 ? slots[afterSpaceIdx]! : "none";
					if (leftKind !== "content" || afterSpaceKind !== "content") {
						drop[rightImmediate] = true;
						continue;
					}
				}
				if (leftIdx >= 0 && slots[leftIdx] === "space") {
					const rightIdx = nextKept(i + 1);
					const rightKind = rightIdx >= 0 ? slots[rightIdx]! : "none";
					const beforeSpaceIdx = prevKept(leftIdx - 1);
					const beforeSpaceKind =
						beforeSpaceIdx >= 0 ? slots[beforeSpaceIdx]! : "none";
					if (rightKind !== "content" || beforeSpaceKind !== "content") {
						drop[leftIdx] = true;
					}
				}
			}
			let runStart = -1;
			for (let i = 0; i <= slots.length; i++) {
				if (i < slots.length && drop[i]) {
					if (runStart < 0) runStart = i;
				} else if (runStart >= 0) {
					ranges.push({ from: blockStart + runStart, to: blockStart + i });
					runStart = -1;
				}
			}
		}
		pos = blockStart + slots.length + 1;
	}
	return ranges;
}

function inlineNodeSize(node: RichNodeJSON): number {
	if (node.type === "text") return (node.text ?? "").length;
	return 1;
}

/** 计算文档末尾的合法文本光标位置（最后一个 paragraph 的末尾）。 */
export function richDocEndPos(doc: RichNodeJSON | null | undefined): number {
	const blocks = doc?.content;
	if (!blocks?.length) return 1;
	let pos = 0;
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i]!;
		pos += 1; // paragraph 起始边界
		for (const child of block.content ?? []) {
			pos += inlineNodeSize(child);
		}
		if (i === blocks.length - 1) return pos;
		pos += 1; // paragraph 结束边界
	}
	return 1;
}

export type RichSuggestionMatch = ActiveSuggestionQuery & {
	docRange: RichRange;
};

/**
 * 基于当前文档和选区计算正在输入的 `@` 或 `/` 补全查询，以及对应的文档替换范围。
 * 仅在折叠文本选区（无框选）时触发。
 */
export function activeRichSuggestion(
	doc: RichNodeJSON | null | undefined,
	selection: RichSelectionJSON | null | undefined,
): RichSuggestionMatch | null {
	if (!doc?.content?.length || !selection) return null;
	if (selection.type !== "text") return null;
	const anchor = selection.anchor ?? 0;
	const head = selection.head ?? anchor;
	if (anchor !== head) return null;

	let pos = 0;
	let valueOffset = 0;
	for (let blockIndex = 0; blockIndex < doc.content.length; blockIndex++) {
		const block = doc.content[blockIndex]!;
		const blockStart = pos + 1;
		let cursor = blockStart;
		const children = block.content ?? [];
		const blockInlineLen = children.reduce(
			(sum, child) => sum + inlineNodeSize(child),
			0,
		);
		const blockEnd = blockStart + blockInlineLen;

		if (head >= blockStart && head <= blockEnd) {
			// 在当前段落内，查找紧贴光标之前的连续纯文本片段（遇到 mention 或 hardBreak 截断）。
			let segStartPos = blockStart;
			let segStartValueOffset = valueOffset;
			let segText = "";
			let hasLeadingContent = blockIndex > 0;
			let hasLeadingImage = false;

			for (const child of children) {
				const size = inlineNodeSize(child);
				const childStart = cursor;
				const childEnd = cursor + size;

				if (childStart >= head) break;

				if (child.type === "text") {
					const text = child.text ?? "";
					const take = Math.min(text.length, head - childStart);
					if (segText.length === 0) {
						segStartPos = childStart;
						segStartValueOffset = valueOffset;
					}
					segText += text.slice(0, take);
					valueOffset += take;
				} else {
					const raw =
						child.type === CHAT_MENTION_NODE_TYPE &&
						typeof child.attrs?.raw === "string"
							? child.attrs.raw
							: child.type === "hardBreak"
								? "\n"
								: "";
					valueOffset += raw.length;
					if (
						child.type === CHAT_MENTION_NODE_TYPE &&
						child.attrs?.kind === "image"
					) {
						hasLeadingImage = true;
						hasLeadingContent ||= segText.trim().length > 0;
					} else {
						hasLeadingContent = true;
					}
					segText = "";
					segStartPos = childEnd;
					segStartValueOffset = valueOffset;
				}
				cursor = childEnd;
			}

			if (!segText) return null;
			const lastSep = Math.max(
				segText.lastIndexOf(" "),
				segText.lastIndexOf("\n"),
				segText.lastIndexOf("\t"),
			);
			const tokenOffsetInSeg = lastSep + 1;
			const token = segText.slice(tokenOffsetInSeg);
			const trigger = token[0];
			if (trigger !== "@" && trigger !== "/") return null;
			if (
				trigger === "/" &&
				(hasLeadingContent ||
					(tokenOffsetInSeg !== 0 &&
						!(
							hasLeadingImage &&
							segText.slice(0, tokenOffsetInSeg).trim().length === 0
						)))
			) {
				return null;
			}
			if (token.slice(1).includes(" ")) return null;
			const from = segStartPos + tokenOffsetInSeg;
			const start = segStartValueOffset + tokenOffsetInSeg;
			return {
				trigger,
				query: token.slice(1),
				start,
				end: start + token.length,
				docRange: { from, to: head },
			};
		}

		// 跳过未命中的段落，同步累计纯文本偏移。
		valueOffset += serializeInline(children).length + 1;
		pos = blockEnd + 1;
	}
	return null;
}
