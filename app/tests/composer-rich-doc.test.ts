import {
	createRichEditor,
	defineExtension,
	Document,
	insertContentAt,
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
	buildRichImageInsertNodes,
	CHAT_MENTION_NODE_TYPE,
	sliceToPlainText,
	findRichImageNodeRanges,
	findRichImageRemovalRanges,
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

test("buildRichImageInsertNodes adds spaces around and between consecutive images, and removal cleans them up", () => {
	const mention = defineExtension({
		name: CHAT_MENTION_NODE_TYPE,
		node: {
			inline: true,
			group: "inline",
			atom: true,
			attrs: { kind: {}, path: {}, label: {}, detail: {}, raw: {} },
		},
	});
	const editor = createRichEditor({
		doc: valueToRichDoc("", sessions),
		extensions: [Document, Paragraph, richExtension("text"), mention],
	});
	const img1 = { id: "img-1", name: "a.png", size: 10 };
	const img2 = { id: "img-2", name: "b.png", size: 20 };

	// 1) Consecutive single pastes add a single space between images and a trailing space.
	const pos1 = richDocEndPos(editor.doc);
	editor.run(
		insertContentAt(pos1, buildRichImageInsertNodes(editor.doc, pos1, [img1]), {
			updateSelection: true,
		}),
	);
	const pos2 = editor.selection.head ?? richDocEndPos(editor.doc);
	editor.run(
		insertContentAt(pos2, buildRichImageInsertNodes(editor.doc, pos2, [img2]), {
			updateSelection: true,
		}),
	);
	expect(
		(editor.doc.content?.[0]?.content ?? []).map((node) =>
			node.type === "text" ? node.text : node.attrs?.path,
		),
	).toEqual(["img-1", " ", "img-2", " "]);

	// 2) Slash trigger still works right after leading images + trailing space.
	editor.run(
		insertContentAt(
			richDocEndPos(editor.doc),
			{ type: "text", text: "/new" },
			{ updateSelection: true },
		),
	);
	expect(activeRichSuggestion(editor.doc, editor.selection)?.trigger).toBe("/");

	// 3) Removing the first image cleans its trailing space; removing the second leaves "/new".
	const ranges1 = findRichImageRemovalRanges(editor.doc, new Set(["img-1"]));
	editor.dispatch({
		steps: ranges1.reverse().map((r) => ({ stepType: "replace", ...r })),
	});
	expect(richDocImageIds(editor.doc)).toEqual(["img-2"]);
	expect(richDocToValue(editor.doc)).toBe(" /new");

	const ranges2 = findRichImageRemovalRanges(editor.doc, new Set(["img-2"]));
	editor.dispatch({
		steps: ranges2.reverse().map((r) => ({ stepType: "replace", ...r })),
	});
	expect(richDocImageIds(editor.doc)).toEqual([]);
	expect(richDocToValue(editor.doc)).toBe("/new");

	// 4) Inserting between words adds spaces without doubling existing spaces, and removing does not glue words.
	const betweenDoc = valueToRichDoc("hello world", sessions);
	const betweenEditor = createRichEditor({
		doc: betweenDoc,
		extensions: [Document, Paragraph, richExtension("text"), mention],
	});
	// Cursor right after "hello" (before " world"): pos = 1 + 5 = 6.
	betweenEditor.run(
		insertContentAt(
			6,
			buildRichImageInsertNodes(betweenEditor.doc, 6, [img1, img2]),
			{ updateSelection: true },
		),
	);
	expect(
		(betweenEditor.doc.content?.[0]?.content ?? []).map((node) =>
			node.type === "text" ? node.text : node.attrs?.path,
		),
	).toEqual(["hello ", "img-1", " ", "img-2", " world"]);
	const removeBoth = findRichImageRemovalRanges(
		betweenEditor.doc,
		new Set(["img-1", "img-2"]),
	);
	betweenEditor.dispatch({
		steps: removeBoth.reverse().map((r) => ({ stepType: "replace", ...r })),
	});
	expect(richDocToValue(betweenEditor.doc)).toBe("hello world");
});
