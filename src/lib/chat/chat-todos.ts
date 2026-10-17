import type { ChatMessage } from "@/lib/chat/conversation-types";

/**
 * 会话待办：Pi 生态的 todo 工具（magic-context 扩展的 `todowrite` 等）。
 *
 * 这类工具每次调用都携带**完整**清单，所以"最后一次调用"就是当前状态。
 * 解析不出待办时返回 null，调用方退回通用工具渲染，不丢信息。
 */

export type ChatTodoStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "cancelled";

export type ChatTodoPriority = "high" | "medium" | "low";

export type ChatTodoItem = {
	id: string;
	text: string;
	status: ChatTodoStatus;
	priority?: ChatTodoPriority;
};

export type ChatTodoCounts = {
	total: number;
	completed: number;
	inProgress: number;
	pending: number;
	cancelled: number;
};

export type ChatTodoProgress = {
	items: ChatTodoItem[];
	counts: ChatTodoCounts;
	current?: ChatTodoItem;
	/** 全部条目都已结束（完成或取消）。 */
	complete: boolean;
};

/** 携带待办清单的工具名；不同扩展命名略有差异。 */
export const CHAT_TODO_TOOL_NAMES = new Set([
	"todowrite",
	"todo_write",
	"todoupdate",
	"todo_update",
]);

export function isChatTodoTool(toolName: string): boolean {
	return CHAT_TODO_TOOL_NAMES.has(toolName.trim().toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asText(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}

function normalizeStatus(raw: unknown): ChatTodoStatus | null {
	const value = asText(raw)
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	switch (value) {
		case "pending":
		case "todo":
		case "open":
			return "pending";
		case "in_progress":
		case "inprogress":
		case "doing":
		case "active":
			return "in_progress";
		case "completed":
		case "complete":
		case "done":
			return "completed";
		case "cancelled":
		case "canceled":
			return "cancelled";
		default:
			return null;
	}
}

function normalizePriority(raw: unknown): ChatTodoPriority | undefined {
	switch (asText(raw).trim().toLowerCase()) {
		case "high":
			return "high";
		case "medium":
		case "mid":
			return "medium";
		case "low":
			return "low";
		default:
			return undefined;
	}
}

function todoFromUnknown(row: unknown, index: number): ChatTodoItem | null {
	const record = asRecord(row);
	if (!record) return null;
	const text = asText(record.content ?? record.text ?? record.task).trim();
	const status = normalizeStatus(record.status ?? record.state);
	if (!text || !status) return null;
	const priority = normalizePriority(record.priority);
	return {
		id: asText(record.id) || `todo-${index}`,
		text,
		status,
		...(priority ? { priority } : {}),
	};
}

function todoListFromUnknown(payload: unknown): ChatTodoItem[] | null {
	const record = asRecord(payload);
	const list = Array.isArray(payload)
		? payload
		: Array.isArray(record?.todos)
			? record.todos
			: Array.isArray(record?.items)
				? record.items
				: null;
	if (!list) return null;
	const items = list
		.map((row, index) => todoFromUnknown(row, index))
		.filter((item): item is ChatTodoItem => item !== null);
	return items.length > 0 ? items : null;
}

/**
 * 从工具调用参数解析待办；参数不是清单时再试工具结果
 * （magic-context 把同一份清单放进 `details.todos`）。
 */
export function parseChatTodos(
	args: unknown,
	fallback?: unknown,
): ChatTodoItem[] | null {
	const fromArgs = todoListFromUnknown(args);
	if (fromArgs) return fromArgs;
	if (fallback === undefined || fallback === null) return null;
	const fallbackRecord = asRecord(fallback);
	return (
		todoListFromUnknown(fallback) ??
		todoListFromUnknown(fallbackRecord?.details) ??
		null
	);
}

export function countChatTodos(items: readonly ChatTodoItem[]): ChatTodoCounts {
	const counts: ChatTodoCounts = {
		total: items.length,
		completed: 0,
		inProgress: 0,
		pending: 0,
		cancelled: 0,
	};
	for (const item of items) {
		if (item.status === "completed") counts.completed += 1;
		else if (item.status === "in_progress") counts.inProgress += 1;
		else if (item.status === "cancelled") counts.cancelled += 1;
		else counts.pending += 1;
	}
	return counts;
}

/** 当前所在的那一条：优先进行中，其次第一条待办，否则最后一条。 */
export function activeChatTodo(
	items: readonly ChatTodoItem[],
): ChatTodoItem | undefined {
	return (
		items.find((item) => item.status === "in_progress") ??
		items.find((item) => item.status === "pending") ??
		items.at(-1)
	);
}

export function buildChatTodoProgress(
	items: readonly ChatTodoItem[],
): ChatTodoProgress {
	const counts = countChatTodos(items);
	return {
		items: [...items],
		counts,
		current: activeChatTodo(items),
		complete: counts.completed + counts.cancelled === counts.total,
	};
}

/**
 * 最后一个用户轮里的待办快照；跨过用户消息就不再往前找，避免旧轮清单常驻。
 */
export function latestTurnChatTodos(
	messages: readonly ChatMessage[],
): ChatTodoProgress | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "user") return null;
		if (message.role !== "assistant") continue;
		const content = message.content ?? [];
		for (let itemIndex = content.length - 1; itemIndex >= 0; itemIndex -= 1) {
			const item = content[itemIndex];
			if (item.type !== "tool" || !isChatTodoTool(item.toolName)) continue;
			const items = parseChatTodos(item.args, item.result);
			if (items) return buildChatTodoProgress(items);
		}
	}
	return null;
}
