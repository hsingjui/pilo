import assert from "node:assert/strict";
import test from "node:test";

import {
	appendAssistantTextContent,
	appendAssistantThinkingContent,
	finishAssistantThinkingContent,
	getAssistantStreamingLabel,
	reconcileAssistantTextContent,
	startAssistantThinkingContent,
	upsertToolContent,
	type AssistantContentItem,
} from "../src/lib/chat-activity-state.ts";
import { getReplyRunwayHeight } from "../src/lib/chat-scroll-state.ts";
import { formatWorkDuration } from "../src/lib/format-duration.ts";

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
