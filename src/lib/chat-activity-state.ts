import type { AssistantActivity } from "@/components/chat/chat-activity";

export type AssistantTextContent = {
	id: string;
	type: "text";
	text: string;
};

export type AssistantContentItem = AssistantTextContent | AssistantActivity;

export type AssistantContentDisplaySections = {
	work: AssistantContentItem[];
	final: AssistantContentItem[];
	hasCollapsedWork: boolean;
};

type ToolActivity = Extract<AssistantActivity, { type: "tool" }>;

export type AssistantActivitySummary = {
	hasThought: boolean;
	readFileCount: number;
	createFileCount: number;
	editFileCount: number;
	commandCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toolFilePaths(activity: ToolActivity): string[] {
	if (!isRecord(activity.args)) return [];
	const paths = new Set<string>();
	for (const key of ["path", "filePath"]) {
		const value = activity.args[key];
		if (typeof value === "string" && value.trim()) paths.add(value.trim());
	}
	for (const key of ["paths", "filePaths"]) {
		const value = activity.args[key];
		if (!Array.isArray(value)) continue;
		for (const item of value) {
			if (typeof item === "string" && item.trim()) paths.add(item.trim());
		}
	}
	return [...paths];
}

export function summarizeAssistantActivity(
	activity: readonly AssistantActivity[],
): AssistantActivitySummary {
	const readPaths = new Set<string>();
	const createPaths = new Set<string>();
	const editPaths = new Set<string>();
	let readCallsWithoutPath = 0;
	let createCallsWithoutPath = 0;
	let editCallsWithoutPath = 0;
	let commandCount = 0;
	let hasThought = false;

	for (const item of activity) {
		if (item.type === "thinking") {
			hasThought = true;
			continue;
		}

		const paths = toolFilePaths(item);
		switch (item.toolName.toLowerCase()) {
			case "read":
				if (paths.length === 0) readCallsWithoutPath += 1;
				else for (const path of paths) readPaths.add(path);
				break;
			case "write":
				if (paths.length === 0) createCallsWithoutPath += 1;
				else for (const path of paths) createPaths.add(path);
				break;
			case "edit":
				if (paths.length === 0) editCallsWithoutPath += 1;
				else for (const path of paths) editPaths.add(path);
				break;
			default:
				commandCount += 1;
		}
	}

	return {
		hasThought,
		readFileCount: readPaths.size + readCallsWithoutPath,
		createFileCount: createPaths.size + createCallsWithoutPath,
		editFileCount: editPaths.size + editCallsWithoutPath,
		commandCount,
	};
}

export function getAssistantActivities(
	content: AssistantContentItem[] | undefined,
): AssistantActivity[] {
	return (content ?? []).filter(
		(item): item is AssistantActivity => item.type !== "text",
	);
}

/**
 * Finished turns keep only the final contiguous text run expanded. Everything
 * before that run is prior work (intermediate prose, thinking and tool calls)
 * and can be mounted lazily behind one disclosure. If a turn has no genuine
 * text tail, keep it fully visible so interrupted/tool-only turns never collapse
 * to an empty shell.
 */
export function splitAssistantContentForDisplay(
	content: AssistantContentItem[] | undefined,
	isTurnFinished: boolean,
): AssistantContentDisplaySections {
	const items = content ?? [];
	if (!isTurnFinished || items.length <= 1) {
		return { work: [], final: items, hasCollapsedWork: false };
	}

	let finalTextStart = items.length;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		if (items[index]?.type !== "text") break;
		finalTextStart = index;
	}

	if (finalTextStart === 0 || finalTextStart === items.length) {
		return { work: [], final: items, hasCollapsedWork: false };
	}

	const final = items.slice(finalTextStart);
	const hasVisibleFinalText = final.some(
		(item) => item.type === "text" && item.text.trim().length > 0,
	);
	if (!hasVisibleFinalText) {
		return { work: [], final: items, hasCollapsedWork: false };
	}

	return {
		work: items.slice(0, finalTextStart),
		final,
		hasCollapsedWork: true,
	};
}

export function appendAssistantTextContent(
	content: AssistantContentItem[] | undefined,
	delta: string,
	createId: () => string,
): AssistantContentItem[] {
	const items = content ?? [];
	if (!delta) return items;
	const last = items[items.length - 1];
	if (last?.type === "text") {
		const next = [...items];
		next[next.length - 1] = { ...last, text: `${last.text}${delta}` };
		return next;
	}
	return [...items, { id: createId(), type: "text", text: delta }];
}

export function reconcileAssistantTextContent(
	content: AssistantContentItem[] | undefined,
	text: string,
	createId: () => string,
): AssistantContentItem[] {
	const items = content ?? [];
	const textItems = items.filter(
		(item): item is AssistantTextContent => item.type === "text",
	);
	const currentText = textItems.map((item) => item.text).join("");
	if (currentText === text) return items;
	if (text.startsWith(currentText)) {
		return appendAssistantTextContent(
			items,
			text.slice(currentText.length),
			createId,
		);
	}
	if (textItems.length === 0) {
		return text ? [...items, { id: createId(), type: "text", text }] : items;
	}

	let offset = 0;
	let remainingTextItems = textItems.length;
	let changed = false;
	const next = [...items];
	for (let index = 0; index < next.length; index += 1) {
		const item = next[index];
		if (item.type !== "text") continue;
		remainingTextItems -= 1;
		const nextText =
			remainingTextItems === 0
				? text.slice(offset)
				: text.slice(offset, offset + item.text.length);
		offset += nextText.length;
		if (nextText === item.text) continue;
		next[index] = { ...item, text: nextText };
		changed = true;
	}
	return changed ? next : items;
}

export function startAssistantThinkingContent(
	content: AssistantContentItem[] | undefined,
	createId: () => string,
): AssistantContentItem[] {
	const items = content ?? [];
	const last = items[items.length - 1];
	if (last?.type === "thinking" && last.status === "running") return items;
	return [
		...items,
		{ id: createId(), type: "thinking", text: "", status: "running" },
	];
}

export function appendAssistantThinkingContent(
	content: AssistantContentItem[] | undefined,
	delta: string,
	createId: () => string,
): AssistantContentItem[] {
	const items = content ?? [];
	if (!delta) return items;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item.type === "thinking" && item.status === "running") {
			const next = [...items];
			next[index] = { ...item, text: `${item.text}${delta}` };
			return next;
		}
	}
	return [
		...items,
		{ id: createId(), type: "thinking", text: delta, status: "running" },
	];
}

export function finishAssistantThinkingContent(
	content: AssistantContentItem[] | undefined,
): AssistantContentItem[] {
	const items = content ?? [];
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item.type === "thinking" && item.status === "running") {
			const next = [...items];
			next[index] = { ...item, status: "complete" };
			return next;
		}
	}
	return items;
}

export function upsertToolContent(
	content: AssistantContentItem[] | undefined,
	toolCallId: string,
	create: () => ToolActivity,
	update: (current: ToolActivity) => ToolActivity,
): AssistantContentItem[] {
	const items = content ?? [];
	const index = items.findIndex(
		(item) => item.type === "tool" && item.id === toolCallId,
	);
	if (index < 0) return [...items, create()];
	const current = items[index];
	if (current.type !== "tool") return items;
	const next = [...items];
	next[index] = update(current);
	return next;
}

export function getAssistantStreamingLabel({
	text,
	activity,
	streaming,
}: {
	text: string;
	activity?: AssistantActivity[];
	streaming?: boolean;
}): string | null {
	if (!streaming) return null;
	const items = activity ?? [];
	if (!text && items.length === 0) return "启动中...";
	if (
		items.some((item) => item.type === "thinking" && item.status === "running")
	) {
		return "思考中";
	}
	return "处理中";
}
