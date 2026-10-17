import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantContentItem } from "../../src/lib/chat/chat-activity-state.ts";
import type { ChatMessage } from "../../src/lib/chat/conversation-types.ts";
import {
	isChatTodoTool,
	latestTurnChatTodos,
	parseChatTodos,
} from "../../src/lib/chat/chat-todos.ts";

/** magic-context 的 `todowrite` 真实调用形状。 */
function todoCall(args: unknown): AssistantContentItem {
	return {
		id: "call-1",
		type: "tool",
		toolName: "todowrite",
		args,
		status: "complete",
	};
}

function assistant(content: AssistantContentItem[]): ChatMessage {
	return {
		id: "assistant-1",
		role: "assistant",
		text: "",
		time: "10:00",
		content,
	};
}

const userMessage: ChatMessage = {
	id: "user-1",
	role: "user",
	text: "做点事",
	time: "09:59",
};

test("todowrite args parse into todo items", () => {
	const items = parseChatTodos({
		todos: [
			{ id: "a", content: "绑定域名", status: "completed", priority: "high" },
			{ content: "审计代码", status: "in_progress" },
		],
	});

	assert.deepEqual(items, [
		{ id: "a", text: "绑定域名", status: "completed", priority: "high" },
		{ id: "todo-1", text: "审计代码", status: "in_progress" },
	]);
});

test("todo items fall back to the tool result details", () => {
	const items = parseChatTodos(
		{ path: "/tmp" },
		{ details: { todos: [{ content: "写文档", status: "pending" }] } },
	);

	assert.deepEqual(items, [
		{ id: "todo-0", text: "写文档", status: "pending" },
	]);
});

test("alias status and priority values normalize", () => {
	const items = parseChatTodos([
		{ task: "甲", state: "DOING", priority: "mid" },
		{ text: "乙", status: "done" },
		{ text: "丙", status: "canceled" },
	]);

	assert.deepEqual(
		items?.map((item) => [item.text, item.status, item.priority]),
		[
			["甲", "in_progress", "medium"],
			["乙", "completed", undefined],
			["丙", "cancelled", undefined],
		],
	);
});

test("payloads without a todo list are not treated as todos", () => {
	assert.equal(parseChatTodos({ command: "ls -la" }), null);
	assert.equal(parseChatTodos([{ content: "没有状态" }]), null);
	assert.equal(parseChatTodos(undefined), null);
});

test("todo tool names match the ecosystem aliases", () => {
	assert.equal(isChatTodoTool("todowrite"), true);
	assert.equal(isChatTodoTool("TodoWrite"), true);
	assert.equal(isChatTodoTool("bash"), false);
});

test("latest turn todos ignore earlier turns", () => {
	const messages = [
		userMessage,
		assistant([
			todoCall({ todos: [{ content: "旧任务", status: "pending" }] }),
		]),
		{ ...userMessage, id: "user-2", text: "新一轮" },
	];

	assert.equal(latestTurnChatTodos(messages), null);
});

test("latest turn todos report counts, current task and completion", () => {
	const messages = [
		userMessage,
		assistant([
			todoCall({ todos: [{ content: "旧任务", status: "pending" }] }),
			todoCall({
				todos: [
					{ content: "第一步", status: "completed" },
					{ content: "第二步", status: "in_progress", priority: "high" },
					{ content: "第三步", status: "pending" },
				],
			}),
		]),
	];

	const progress = latestTurnChatTodos(messages);

	assert.equal(progress?.counts.total, 3);
	assert.equal(progress?.counts.completed, 1);
	assert.equal(progress?.counts.inProgress, 1);
	assert.equal(progress?.current?.text, "第二步");
	assert.equal(progress?.complete, false);
});

test("an all-completed list is reported as complete", () => {
	const progress = latestTurnChatTodos([
		userMessage,
		assistant([
			todoCall({
				todos: [
					{ content: "甲", status: "completed" },
					{ content: "乙", status: "cancelled" },
				],
			}),
		]),
	]);

	assert.equal(progress?.complete, true);
});
