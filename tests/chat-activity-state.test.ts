import assert from "node:assert/strict";
import test from "node:test";

import { scrollChatViewportToRealBottom } from "../src/components/chat/chat-sticky-scroll-dom.ts";
import {
	appendAssistantTextContent,
	appendAssistantThinkingContent,
	finishAssistantThinkingContent,
	getAssistantStreamingLabel,
	reconcileAssistantTextContent,
	splitAssistantContentForDisplay,
	startAssistantThinkingContent,
	summarizeAssistantActivity,
	upsertToolContent,
	type AssistantContentItem,
} from "../src/lib/chat-activity-state.ts";
import { buildConversationOutline } from "../src/lib/conversation-outline.ts";
import { getReplyRunwayHeight } from "../src/lib/chat-scroll-state.ts";
import {
	getOutlineIndexForMessageIndex,
	getOutlineIndexForScrollOffset,
	shouldInitializeShortChatPromoted,
	shouldPromoteShortChatVirtualization,
	shouldRenderPlainShortChat,
} from "../src/lib/chat-virtualization.ts";
import { formatWorkDuration } from "../src/lib/format-duration.ts";

function runBottomClampMode(mode: "dom-only" | "virtua-only" | "none") {
	const calls: number[] = [];
	const scrollElement = {
		clientHeight: 400,
		scrollHeight: 1_000,
		scrollTop: 540,
	};
	const result = scrollChatViewportToRealBottom({
		itemCount: 8,
		vlist: {
			scrollToIndex(index) {
				calls.push(index);
			},
		},
		scrollElement,
		bottomOffset: 40,
		mode,
	});
	return { calls, scrollTop: scrollElement.scrollTop, result };
}

test("chat bottom clamp targets Virtua and the real DOM bottom once", () => {
	const calls: Array<{ index: number; align?: string; offset?: number }> = [];
	const scrollElement = {
		clientHeight: 400,
		scrollHeight: 1_000,
		scrollTop: 540,
	};

	scrollChatViewportToRealBottom({
		itemCount: 8,
		vlist: {
			scrollToIndex(index, options) {
				calls.push({ index, align: options?.align, offset: options?.offset });
			},
		},
		scrollElement,
		bottomOffset: 40,
	});

	assert.deepEqual(calls, [{ index: 7, align: "end", offset: 40 }]);
	assert.equal(scrollElement.scrollTop, 600);
});

test("chat bottom clamp experiment modes isolate scroll owners", () => {
	assert.deepEqual(runBottomClampMode("dom-only"), {
		calls: [],
		scrollTop: 600,
		result: { virtuaScrolled: false, domScrolled: true },
	});
	assert.deepEqual(runBottomClampMode("virtua-only"), {
		calls: [7],
		scrollTop: 540,
		result: { virtuaScrolled: true, domScrolled: false },
	});
	assert.deepEqual(runBottomClampMode("none"), {
		calls: [],
		scrollTop: 540,
		result: { virtuaScrolled: false, domScrolled: false },
	});
});

test("interleaved concurrent tool calls stay isolated by toolCallId", () => {
	let activity: AssistantContentItem[] = [];

	const start = (id: string, command: string) => {
		activity = upsertToolContent(
			activity,
			id,
			() => ({
				id,
				type: "tool",
				toolName: "bash",
				args: { command },
				status: "running",
			}),
			(current) => ({ ...current, args: { command }, status: "running" }),
		);
	};
	const update = (id: string, command: string, output: string) => {
		activity = upsertToolContent(
			activity,
			id,
			() => ({
				id,
				type: "tool",
				toolName: "bash",
				args: { command },
				result: output,
				status: "running",
			}),
			(current) => ({
				...current,
				args: { command },
				result: output,
				status: "running",
			}),
		);
	};
	const finish = (id: string, output: string) => {
		activity = upsertToolContent(
			activity,
			id,
			() => ({
				id,
				type: "tool",
				toolName: "bash",
				result: output,
				status: "complete",
			}),
			(current) => ({ ...current, result: output, status: "complete" }),
		);
	};

	start("call-a", "sleep 1 && echo A");
	start("call-b", "echo B");
	update("call-b", "echo B", "B partial");
	update("call-a", "sleep 1 && echo A", "A partial");
	finish("call-b", "B done");
	finish("call-a", "A done");

	assert.deepEqual(activity, [
		{
			id: "call-a",
			type: "tool",
			toolName: "bash",
			args: { command: "sleep 1 && echo A" },
			result: "A done",
			status: "complete",
		},
		{
			id: "call-b",
			type: "tool",
			toolName: "bash",
			args: { command: "echo B" },
			result: "B done",
			status: "complete",
		},
	]);
});

test("assistant content keeps thinking and text in event order", () => {
	let nextId = 0;
	const createId = () => `content-${++nextId}`;
	let content = startAssistantThinkingContent([], createId);
	content = appendAssistantThinkingContent(content, "先分析", createId);
	content = finishAssistantThinkingContent(content);
	content = appendAssistantTextContent(content, "第一段回复", createId);
	content = appendAssistantTextContent(content, "继续输出", createId);
	content = startAssistantThinkingContent(content, createId);
	content = appendAssistantThinkingContent(content, "回复后继续思考", createId);
	content = finishAssistantThinkingContent(content);
	content = appendAssistantTextContent(content, "第二段回复", createId);

	assert.deepEqual(
		content.map((item) => ({
			type: item.type,
			text: item.type === "tool" ? undefined : item.text,
		})),
		[
			{ type: "thinking", text: "先分析" },
			{ type: "text", text: "第一段回复继续输出" },
			{ type: "thinking", text: "回复后继续思考" },
			{ type: "text", text: "第二段回复" },
		],
	);

	content = reconcileAssistantTextContent(
		content,
		"第一段回复继续输出第二段回复（最终）",
		createId,
	);
	assert.deepEqual(
		content.map((item) => ({
			type: item.type,
			text: item.type === "tool" ? undefined : item.text,
		})),
		[
			{ type: "thinking", text: "先分析" },
			{ type: "text", text: "第一段回复继续输出" },
			{ type: "thinking", text: "回复后继续思考" },
			{ type: "text", text: "第二段回复（最终）" },
		],
	);
});

test("tool updates keep their original position among ordered content", () => {
	let nextId = 0;
	const createId = () => `content-${++nextId}`;
	let content = appendAssistantTextContent([], "before", createId);
	content = upsertToolContent(
		content,
		"call-a",
		() => ({
			id: "call-a",
			type: "tool",
			toolName: "bash",
			args: { command: "a" },
			status: "running",
		}),
		(current) => current,
	);
	content = upsertToolContent(
		content,
		"call-b",
		() => ({
			id: "call-b",
			type: "tool",
			toolName: "bash",
			args: { command: "b" },
			status: "running",
		}),
		(current) => current,
	);
	content = appendAssistantTextContent(content, "after", createId);
	content = upsertToolContent(
		content,
		"call-a",
		() => {
			throw new Error("existing call should update");
		},
		(current) => ({ ...current, result: "A done", status: "complete" }),
	);

	assert.deepEqual(
		content.map((item) =>
			item.type === "tool" ? item.id : `${item.type}:${item.text}`,
		),
		["text:before", "call-a", "call-b", "text:after"],
	);
});

test("assistant streaming label follows pending and active response phases", () => {
	assert.equal(
		getAssistantStreamingLabel({ text: "", streaming: true }),
		"启动中...",
	);
	assert.equal(
		getAssistantStreamingLabel({
			text: "",
			streaming: true,
			activity: [
				{
					id: "thinking-1",
					type: "thinking",
					text: "",
					status: "running",
				},
			],
		}),
		"思考中",
	);
	assert.equal(
		getAssistantStreamingLabel({ text: "hello", streaming: true }),
		"处理中",
	);
	assert.equal(
		getAssistantStreamingLabel({ text: "hello", streaming: false }),
		null,
	);
});

test("work duration uses the same compact shape as Lody", () => {
	assert.equal(formatWorkDuration(11_999), "11秒");
	assert.equal(formatWorkDuration(65_999), "1分 05秒");
	assert.equal(formatWorkDuration(3_723_999), "1小时 02分 03秒");
});

test("assistant activity summary groups file work and other tools", () => {
	const summary = summarizeAssistantActivity([
		{ id: "think-1", type: "thinking", text: "plan", status: "complete" },
		{
			id: "read-1",
			type: "tool",
			toolName: "read",
			args: { path: "src/a.ts" },
			status: "complete",
		},
		{
			id: "read-2",
			type: "tool",
			toolName: "read",
			args: { path: "src/a.ts" },
			status: "complete",
		},
		{
			id: "read-3",
			type: "tool",
			toolName: "read",
			args: { filePath: "src/b.ts" },
			status: "complete",
		},
		{
			id: "write-1",
			type: "tool",
			toolName: "write",
			args: { path: "src/new.ts" },
			status: "complete",
		},
		{
			id: "edit-1",
			type: "tool",
			toolName: "edit",
			args: { paths: ["src/a.ts", "src/c.ts"] },
			status: "complete",
		},
		{
			id: "bash-1",
			type: "tool",
			toolName: "bash",
			args: { command: "pnpm check" },
			status: "complete",
		},
		{
			id: "search-1",
			type: "tool",
			toolName: "grep",
			args: { pattern: "foo" },
			status: "complete",
		},
	]);

	assert.deepEqual(summary, {
		hasThought: true,
		readFileCount: 2,
		createFileCount: 1,
		editFileCount: 2,
		commandCount: 2,
	});
});

test("finished assistant turns keep only the final contiguous text run expanded", () => {
	const content: AssistantContentItem[] = [
		{ id: "draft", type: "text", text: "I will inspect the files first." },
		{
			id: "think",
			type: "thinking",
			text: "Need to compare both implementations.",
			status: "complete",
		},
		{
			id: "read",
			type: "tool",
			toolName: "read",
			args: { path: "src/app.ts" },
			status: "complete",
		},
		{ id: "final-a", type: "text", text: "Implemented the change." },
		{ id: "final-b", type: "text", text: " Tests pass." },
	];

	const sections = splitAssistantContentForDisplay(content, true);
	assert.equal(sections.hasCollapsedWork, true);
	assert.deepEqual(
		sections.work.map((item) => item.id),
		["draft", "think", "read"],
	);
	assert.deepEqual(
		sections.final.map((item) => item.id),
		["final-a", "final-b"],
	);
});

test("short streaming and tool-only assistant turns stay fully expanded", () => {
	const content: AssistantContentItem[] = [
		{
			id: "think",
			type: "thinking",
			text: "Still working",
			status: "running",
		},
		{
			id: "tool",
			type: "tool",
			toolName: "bash",
			status: "running",
		},
	];

	assert.deepEqual(splitAssistantContentForDisplay(content, false), {
		work: [],
		final: content,
		hasCollapsedWork: false,
	});
	assert.deepEqual(splitAssistantContentForDisplay(content, true), {
		work: [],
		final: content,
		hasCollapsedWork: false,
	});
});

test("a single streaming work phase remains fully visible", () => {
	const content: AssistantContentItem[] = [
		{ id: "intro", type: "text", text: "I will inspect this first." },
		{
			id: "tool",
			type: "tool",
			toolName: "read",
			status: "complete",
		},
		{ id: "live", type: "text", text: "The first result is useful." },
	];

	assert.deepEqual(splitAssistantContentForDisplay(content, false), {
		work: [],
		final: content,
		hasCollapsedWork: false,
	});
});

test("streaming assistant turns collapse completed phases and keep only the live tail", () => {
	const content: AssistantContentItem[] = [
		{ id: "intro", type: "text", text: "I will inspect the runtime." },
		{
			id: "tool-1",
			type: "tool",
			toolName: "read",
			status: "complete",
		},
		{ id: "checkpoint", type: "text", text: "The first path looks safe." },
		{
			id: "tool-2",
			type: "tool",
			toolName: "bash",
			status: "running",
		},
		{ id: "live", type: "text", text: "Now checking transport." },
	];

	const sections = splitAssistantContentForDisplay(content, false);
	assert.equal(sections.hasCollapsedWork, true);
	assert.deepEqual(
		sections.work.map((item) => item.id),
		["intro", "tool-1", "checkpoint"],
	);
	assert.deepEqual(
		sections.final.map((item) => item.id),
		["tool-2", "live"],
	);
});

test("reply runway is only reserved for an already scrollable conversation", () => {
	assert.equal(
		getReplyRunwayHeight({ viewportHeight: 600, scrollHeight: 620 }),
		undefined,
	);
	assert.equal(
		getReplyRunwayHeight({ viewportHeight: 600, scrollHeight: 1_200 }),
		192,
	);
	assert.equal(
		getReplyRunwayHeight({
			viewportHeight: 600,
			scrollHeight: 1_200,
			enabled: false,
		}),
		undefined,
	);
	assert.equal(
		getReplyRunwayHeight({ viewportHeight: 300, scrollHeight: 900 }),
		144,
	);
	assert.equal(
		getReplyRunwayHeight({ viewportHeight: 1_200, scrollHeight: 2_000 }),
		256,
	);
});

test("short chat stays plain until it is promoted", () => {
	assert.equal(
		shouldRenderPlainShortChat({
			enabled: true,
			promoted: false,
		}),
		true,
	);
	assert.equal(
		shouldRenderPlainShortChat({
			enabled: true,
			promoted: true,
		}),
		false,
	);
});

test("mounting an active medium chat keeps it plain until streaming finishes", () => {
	assert.equal(
		shouldInitializeShortChatPromoted({
			enabled: true,
			messageCount: 10,
			streaming: true,
		}),
		false,
	);
	assert.equal(
		shouldInitializeShortChatPromoted({
			enabled: true,
			messageCount: 10,
			streaming: false,
		}),
		true,
	);
	assert.equal(
		shouldInitializeShortChatPromoted({
			enabled: true,
			messageCount: 17,
			streaming: true,
		}),
		true,
	);
});

test("short chat virtualization waits for an idle follow state after streaming", () => {
	const base = {
		enabled: true,
		promoted: false,
		active: true,
		ready: true,
		messageCount: 10,
		sticky: true,
	};
	assert.equal(
		shouldPromoteShortChatVirtualization({ ...base, streaming: true }),
		false,
	);
	assert.equal(
		shouldPromoteShortChatVirtualization({
			...base,
			streaming: false,
			sticky: false,
		}),
		false,
	);
	assert.equal(
		shouldPromoteShortChatVirtualization({
			...base,
			streaming: false,
			sticky: false,
			preparingVisual: true,
		}),
		true,
	);
	assert.equal(
		shouldPromoteShortChatVirtualization({
			...base,
			streaming: false,
		}),
		true,
	);
	assert.equal(
		shouldPromoteShortChatVirtualization({
			...base,
			active: false,
			streaming: false,
		}),
		false,
	);
	assert.equal(
		shouldPromoteShortChatVirtualization({
			...base,
			messageCount: 17,
			streaming: true,
		}),
		false,
	);
});

test("conversation outline records each round start message index", () => {
	const entries = buildConversationOutline([
		{ id: "u1", role: "user", text: "first" },
		{ id: "a1", role: "assistant", text: "reply" },
		{ id: "a2", role: "assistant", text: "more" },
		{ id: "u2", role: "user", text: "second" },
		{ id: "a3", role: "assistant", text: "reply 2" },
	]);

	assert.deepEqual(
		entries.map((entry) => ({
			key: entry.key,
			messageIndex: entry.messageIndex,
		})),
		[
			{ key: "u1", messageIndex: 0 },
			{ key: "u2", messageIndex: 3 },
		],
	);
});

test("outline index follows the virtualized message at the reading line", () => {
	const entries = [
		{ messageIndex: 0 },
		{ messageIndex: 3 },
		{ messageIndex: 8 },
		{ messageIndex: 13 },
	];

	assert.equal(getOutlineIndexForMessageIndex([], 4), -1);
	assert.equal(getOutlineIndexForMessageIndex(entries, 0), 0);
	assert.equal(getOutlineIndexForMessageIndex(entries, 2), 0);
	assert.equal(getOutlineIndexForMessageIndex(entries, 3), 1);
	assert.equal(getOutlineIndexForMessageIndex(entries, 12), 2);
	assert.equal(getOutlineIndexForMessageIndex(entries, 99), 3);
});

test("outline index resolves directly from Virtua item offsets", () => {
	const entries = [
		{ messageIndex: 0 },
		{ messageIndex: 3 },
		{ messageIndex: 8 },
		{ messageIndex: 13 },
	];
	const offsets = new Map([
		[0, 0],
		[3, 360],
		[8, 920],
		[13, 1_480],
	]);
	const getMessageOffset = (messageIndex: number) =>
		offsets.get(messageIndex) ?? Number.POSITIVE_INFINITY;

	assert.equal(getOutlineIndexForScrollOffset([], getMessageOffset, 500), -1);
	assert.equal(getOutlineIndexForScrollOffset(entries, getMessageOffset, 0), 0);
	assert.equal(
		getOutlineIndexForScrollOffset(entries, getMessageOffset, 359),
		1,
	);
	assert.equal(
		getOutlineIndexForScrollOffset(entries, getMessageOffset, 918),
		1,
	);
	assert.equal(
		getOutlineIndexForScrollOffset(entries, getMessageOffset, 919),
		2,
	);
	assert.equal(
		getOutlineIndexForScrollOffset(entries, getMessageOffset, 200, true),
		3,
	);
});
