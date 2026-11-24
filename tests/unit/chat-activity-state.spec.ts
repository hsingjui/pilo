import assert from "node:assert/strict";
import test from "node:test";

import {
	appendAssistantTextContent,
	appendAssistantThinkingContent,
	finishAssistantThinkingContent,
	getAssistantStreamingState,
	lastThinkingLine,
	pickCompactLiveActivity,
	pickCompactLivePreview,
	reconcileAssistantTextContent,
	shouldAutoCollapseAssistantActivity,
	shouldInitiallyOpenAssistantActivity,
	splitActiveCompactContent,
	splitAssistantContentForDisplay,
	startAssistantThinkingContent,
	summarizeAssistantActivity,
	upsertToolContent,
	type AssistantContentItem,
} from "../../shared/chat/chat-activity-state.ts";
import { buildConversationOutline } from "../../shared/chat/conversation-outline.ts";
import { formatWorkDuration } from "../../shared/format-duration.ts";

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

test("assistant streaming state follows pending and active response phases", () => {
	assert.equal(
		getAssistantStreamingState({ text: "", streaming: true }),
		"starting",
	);
	assert.equal(
		getAssistantStreamingState({
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
		"thinking",
	);
	assert.equal(
		getAssistantStreamingState({ text: "hello", streaming: true }),
		"processing",
	);
	assert.equal(
		getAssistantStreamingState({ text: "hello", streaming: false }),
		null,
	);
});

test("work duration uses the same compact shape as Lody", () => {
	const zhUnits = { hour: "小时", minute: "分", second: "秒" };
	assert.equal(formatWorkDuration(11_999, zhUnits), "11秒");
	assert.equal(formatWorkDuration(65_999, zhUnits), "1分 05秒");
	assert.equal(formatWorkDuration(3_723_999, zhUnits), "1小时 02分 03秒");
	const enUnits = { hour: "h", minute: "m", second: "s" };
	assert.equal(formatWorkDuration(11_999, enUnits), "11s");
	assert.equal(formatWorkDuration(65_999, enUnits), "1m 05s");
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

test("activity collapses as soon as following assistant text arrives", () => {
	assert.equal(
		shouldInitiallyOpenAssistantActivity({
			followedByText: true,
			collapseCompletedActivity: true,
		}),
		false,
	);
	assert.equal(
		shouldInitiallyOpenAssistantActivity({
			followedByText: false,
			collapseCompletedActivity: true,
		}),
		true,
	);
	assert.equal(
		shouldInitiallyOpenAssistantActivity({
			followedByText: true,
			collapseCompletedActivity: false,
		}),
		true,
	);
});

test("activity auto-collapse is edge-triggered when following text appears", () => {
	assert.equal(shouldAutoCollapseAssistantActivity(false, true), true);
	assert.equal(shouldAutoCollapseAssistantActivity(false, false), false);
	assert.equal(shouldAutoCollapseAssistantActivity(true, true), false);
	assert.equal(shouldAutoCollapseAssistantActivity(true, false), false);
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

test("streaming assistant turns keep intermediate narration outside the top-level work disclosure", () => {
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
	assert.equal(sections.hasCollapsedWork, false);
	assert.deepEqual(sections.work, []);
	assert.deepEqual(sections.final, content);
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

test("conversation outline summarizes skill invocations by command name", () => {
	const skillText = [
		'<skill name="animate" location="/skills/animate/SKILL.md">',
		"References are relative to /skills/animate.",
		"",
		"# Animate",
		"",
		"Build an animation from scratch.",
		"</skill>",
		"",
		"",
		"给按钮加个过渡",
	].join("\n");
	const entries = buildConversationOutline([
		{ id: "u1", role: "user", text: skillText },
		{ id: "a1", role: "assistant", text: "reply" },
	]);

	assert.equal(entries.length, 1);
	assert.equal(entries[0].title, "/skill:animate 给按钮加个过渡");
});

test("thinking blocks record the timeline shown on the collapsed row", () => {
	let nextId = 0;
	const createId = () => `content-${++nextId}`;
	let content = startAssistantThinkingContent([], createId, 1_000);
	content = appendAssistantThinkingContent(content, "先分析", createId, 1_050);
	content = finishAssistantThinkingContent(content, 4_600);

	const [thinking] = content;
	assert.equal(thinking?.type, "thinking");
	assert.equal(
		thinking?.type === "thinking" ? thinking.startedAtMs : null,
		1_000,
	);
	assert.equal(
		thinking?.type === "thinking" ? thinking.endedAtMs : null,
		4_600,
	);
});

test("thinking deltas keep the block start and never spawn a second block", () => {
	let nextId = 0;
	const createId = () => `content-${++nextId}`;
	let content = startAssistantThinkingContent([], createId, 1_000);
	content = appendAssistantThinkingContent(content, "a", createId, 9_999);
	content = appendAssistantThinkingContent(content, "b", createId, 9_999);

	assert.equal(content.length, 1);
	assert.equal(content[0]?.type === "thinking" ? content[0].text : null, "ab");
	assert.equal(
		content[0]?.type === "thinking" ? content[0].startedAtMs : null,
		1_000,
	);
});

test("a thinking delta without a start still records when it began", () => {
	let nextId = 0;
	const createId = () => `content-${++nextId}`;
	const content = appendAssistantThinkingContent([], "想", createId, 700);

	assert.equal(content.length, 1);
	assert.equal(
		content[0]?.type === "thinking" ? content[0].startedAtMs : null,
		700,
	);
});

test("lastThinkingLine extracts the final non-empty line", () => {
	assert.equal(
		lastThinkingLine("first line\n  second line  \n\n"),
		"second line",
	);
	assert.equal(lastThinkingLine("   \n\t\n"), "");
	assert.equal(lastThinkingLine("abcdef", 3), "abc");
});

test("pickCompactLiveActivity prefers the latest running item and falls back to the last item", () => {
	assert.equal(pickCompactLiveActivity([]), null);

	const runningPick = pickCompactLiveActivity([
		{ id: "t-1", type: "tool", toolName: "read", status: "running" },
		{ id: "t-2", type: "tool", toolName: "edit", status: "running" },
		{ id: "t-3", type: "tool", toolName: "bash", status: "complete" },
	]);
	assert.equal(runningPick?.id, "t-2");

	const fallbackPick = pickCompactLiveActivity([
		{ id: "t-1", type: "tool", toolName: "read", status: "complete" },
		{ id: "t-2", type: "tool", toolName: "bash", status: "complete" },
	]);
	assert.equal(fallbackPick?.id, "t-2");
});

test("pickCompactLivePreview pairs the latest thinking line with the live activity and deduplicates identical thinking", () => {
	assert.deepEqual(pickCompactLivePreview([]), {
		latestThought: null,
		liveActivity: null,
	});

	const thoughtAndTool = pickCompactLivePreview([
		{
			id: "th-1",
			type: "thinking",
			text: "First thought.\nExamining files.",
			status: "complete",
		},
		{ id: "t-1", type: "tool", toolName: "bash", status: "running" },
	]);
	assert.equal(thoughtAndTool.latestThought?.id, "th-1");
	assert.equal(thoughtAndTool.liveActivity?.id, "t-1");

	// When the live activity itself is the latest non-empty thinking block,
	// do not duplicate it on the top row.
	const liveThinkingWithText = pickCompactLivePreview([
		{
			id: "th-1",
			type: "thinking",
			text: "Earlier thought.",
			status: "complete",
		},
		{
			id: "th-2",
			type: "thinking",
			text: "Now thinking...",
			status: "running",
		},
	]);
	assert.equal(liveThinkingWithText.latestThought, null);
	assert.equal(liveThinkingWithText.liveActivity?.id, "th-2");

	// When a new thinking block has started without text yet, keep the prior
	// non-empty thought on top and the active thinking block below.
	const emptyNewThinking = pickCompactLivePreview([
		{
			id: "th-1",
			type: "thinking",
			text: "Earlier thought.",
			status: "complete",
		},
		{ id: "th-2", type: "thinking", text: "   ", status: "running" },
	]);
	assert.equal(emptyNewThinking.latestThought?.id, "th-1");
	assert.equal(emptyNewThinking.liveActivity?.id, "th-2");

	// Tool-only activity has no thinking row.
	const toolOnly = pickCompactLivePreview([
		{ id: "t-1", type: "tool", toolName: "read", status: "running" },
	]);
	assert.equal(toolOnly.latestThought, null);
	assert.equal(toolOnly.liveActivity?.id, "t-1");
});

test("splitActiveCompactContent keeps everything in work while tools run and exposes trailing streaming text once settled", () => {
	const runningContent: AssistantContentItem[] = [
		{ id: "th-1", type: "thinking", text: "Plan", status: "complete" },
		{ id: "txt-1", type: "text", text: "Checking file." },
		{ id: "t-1", type: "tool", toolName: "bash", status: "running" },
	];
	assert.deepEqual(splitActiveCompactContent(runningContent), {
		work: runningContent,
		trailingText: [],
	});

	const trailingContent: AssistantContentItem[] = [
		{ id: "th-1", type: "thinking", text: "Plan", status: "complete" },
		{ id: "txt-1", type: "text", text: "Checking file." },
		{ id: "t-1", type: "tool", toolName: "bash", status: "complete" },
		{ id: "txt-2", type: "text", text: "Streaming answer..." },
	];
	const split = splitActiveCompactContent(trailingContent);
	assert.deepEqual(
		split.work.map((item) => item.id),
		["th-1", "txt-1", "t-1"],
	);
	assert.deepEqual(
		split.trailingText.map((item) => item.id),
		["txt-2"],
	);

	// Whitespace-only trailing text stays inside work until visible text arrives.
	const whitespaceTrailing: AssistantContentItem[] = [
		{ id: "t-1", type: "tool", toolName: "bash", status: "complete" },
		{ id: "txt-blank", type: "text", text: "  \n" },
	];
	assert.deepEqual(splitActiveCompactContent(whitespaceTrailing), {
		work: whitespaceTrailing,
		trailingText: [],
	});
});
