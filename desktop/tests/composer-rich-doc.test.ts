import {
	createRichEditor,
	defineExtension,
	Document,
	Paragraph,
	richExtension,
	setTextSelection,
} from "nsh/base";
import { expect, test } from "nsh/test";

import {
	sessionMentionValue,
	type SessionMention,
} from "@shared/chat/session-mentions";
import {
	activeRichSuggestion,
	CHAT_MENTION_NODE_TYPE,
	sliceToPlainText,
	findRichImageNodeRanges,
	richDocEndPos,
	richDocImageIds,
	richDocToValue,
	valueToRichDoc,
} from "../composer/composer-rich-doc";

const session: SessionMention = {
	connectionId: "local",
	projectId: "p1",
	path: "/sessions/earlier.jsonl",
	title: "Earlier chat",
	projectName: "Pilo",
	updatedAt: 1,
};
const sessions = new Map([[sessionMentionValue(session.path), session]]);

test("valueToRichDoc and richDocToValue round-trip inline file and session mentions", () => {
	const raw =
		'看看 @"src/chat-user-message-body.tsx" 和 @/sessions/earlier.jsonl\n第二行 @"desktop/.nsh/rust/description.json"';
	const doc = valueToRichDoc(raw, sessions);
	expect(richDocToValue(doc)).toBe(raw);
	const firstParagraph = doc.content?.[0]?.content ?? [];
	expect(firstParagraph.map((node) => node.type)).toEqual([
		"text",
		"chatMention",
		"text",
		"chatMention",
	]);
	expect(firstParagraph[1]?.attrs).toMatchObject({
		kind: "file",
		label: "chat-user-message-body.tsx",
		path: "src/chat-user-message-body.tsx",
	});
	expect(firstParagraph[3]?.attrs).toMatchObject({
		kind: "session",
		label: "Earlier chat",
		path: "/sessions/earlier.jsonl",
	});
});

test("activeRichSuggestion locates @ after an inline mention and / only at document start", () => {
	const doc = valueToRichDoc('看看 @"src/a.tsx" @desc', sessions);
	const end = richDocEndPos(doc);
	const match = activeRichSuggestion(doc, {
		type: "text",
		anchor: end,
		head: end,
	});
	expect(match).not.toBeNull();
	expect(match?.trigger).toBe("@");
	expect(match?.query).toBe("desc");
	expect(match?.docRange).toEqual({ from: end - 5, to: end });

	const slashStart = valueToRichDoc("/rev", sessions);
	const slashEnd = richDocEndPos(slashStart);
	expect(
		activeRichSuggestion(slashStart, {
			type: "text",
			anchor: slashEnd,
			head: slashEnd,
		})?.trigger,
	).toBe("/");

	const slashAfterMention = valueToRichDoc('@"src/a.tsx" /rev', sessions);
	const afterEnd = richDocEndPos(slashAfterMention);
	expect(
		activeRichSuggestion(slashAfterMention, {
			type: "text",
			anchor: afterEnd,
			head: afterEnd,
		}),
	).toBeNull();
});

test("inline image nodes render in doc without polluting plain text serialization", () => {
	const images = [
		{ id: "img-1", name: "shot.png", size: 2048 },
		{ id: "img-2", name: "diagram.webp", size: 4096 },
	];
	const doc = valueToRichDoc("请看这两张图", sessions, images);
	expect(richDocImageIds(doc)).toEqual(["img-1", "img-2"]);
	// 序列化文本不包含内部图片占位，仅保留正文和空格。
	expect(richDocToValue(doc)).toBe("请看这两张图");
	const ranges = findRichImageNodeRanges(doc, new Set(["img-1"]));
	expect(ranges.length).toBe(1);
	expect(ranges[0]!.to - ranges[0]!.from).toBe(1); // 图片只占自己的文档位置
});

test("RichEditor uses UTF-16 positions for a Chinese and emoji draft with an inline image", () => {
	const mention = defineExtension({
		name: CHAT_MENTION_NODE_TYPE,
		node: {
			inline: true,
			group: "inline",
			atom: true,
			attrs: { kind: {}, path: {}, label: {}, detail: {}, raw: {} },
		},
	});
	const prefix = "你好😀";
	const doc = valueToRichDoc(
		`${prefix} @desc`,
		sessions,
		[{ id: "img-1", name: "shot.png", size: 1 }],
		new Map([["img-1", prefix.length]]),
	);
	const editor = createRichEditor({
		doc,
		extensions: [Document, Paragraph, richExtension("text"), mention],
	});
	const end = richDocEndPos(editor.doc);
	editor.run(setTextSelection(end));
	expect(editor.selection.head).toBe(end);
	const match = activeRichSuggestion(editor.doc, editor.selection);
	expect(match?.query).toBe("desc");
	const image = findRichImageNodeRanges(editor.doc, new Set(["img-1"]))[0]!;
	expect(editor.nodeAt(image.from)?.type).toBe(CHAT_MENTION_NODE_TYPE);
	editor.dispatch({ steps: [{ stepType: "replace", ...image }] });
	expect(richDocImageIds(editor.doc)).toEqual([]);
	expect(richDocToValue(editor.doc)).toBe(`${prefix} @desc`);
});

test("pasting a rich paragraph keeps a single line around its mention", () => {
	const raw = '看看 @"src/a.tsx" 吧';
	const doc = valueToRichDoc(`${raw}\n下一行`, sessions);
	expect(sliceToPlainText({ content: doc.content })).toBe(`${raw}\n下一行`);
});
