import type { AssistantActivity } from "@shared/chat/chat-activity-types";
import type { ChatMessage } from "@shared/chat/conversation-types";

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

export function shouldInitiallyOpenAssistantActivity({
	followedByText,
	collapseCompletedActivity,
}: {
	followedByText: boolean;
	collapseCompletedActivity: boolean;
}) {
	return !followedByText || !collapseCompletedActivity;
}

export function shouldAutoCollapseAssistantActivity(
	previousEligible: boolean,
	currentEligible: boolean,
) {
	return !previousEligible && currentEligible;
}

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

/** A reply's content in order; a reply saved before content items keeps its activity, then its text. */
export function getAssistantMessageContent(
	message: Extract<ChatMessage, { role: "assistant" }>,
): AssistantContentItem[] {
	if (message.content) return message.content;

	const content: AssistantContentItem[] = [];
	if (message.activity) content.push(...message.activity);
	if (message.text) {
		content.push({
			id: `${message.id}-text`,
			type: "text",
			text: message.text,
		});
	}
	return content;
}

/** The last non-empty line of a thinking trace, scanned from the end. */
export function lastThinkingLine(text: string, maxChars = 8_000): string {
	let end = text.length;
	while (end > 0) {
		const start = text.lastIndexOf("\n", end - 1) + 1;
		const line = text.slice(start, end).trim();
		if (line) return line.slice(0, maxChars);
		end = start - 1;
	}
	return "";
}

/**
 * Picks the single activity to show in the compact live ticker row:
 * the latest running item if any, otherwise the most recent activity item.
 */
export function pickCompactLiveActivity(
	activities: readonly AssistantActivity[],
): AssistantActivity | null {
	for (let index = activities.length - 1; index >= 0; index -= 1) {
		if (activities[index]?.status === "running") return activities[index];
	}
	return activities[activities.length - 1] ?? null;
}

export type CompactLivePreview = {
	/** Latest thinking block with non-empty text, omitted when identical to `liveActivity`. */
	latestThought: Extract<AssistantActivity, { type: "thinking" }> | null;
	/** Current live activity shown underneath: latest running item, or most recent activity. */
	liveActivity: AssistantActivity | null;
};

/**
 * Picks the two live preview slots for compact output: the latest non-empty
 * thinking line on top and the live activity (tool call or thinking) below.
 * Deduplicates when the live activity itself is that latest thinking block.
 */
export function pickCompactLivePreview(
	activities: readonly AssistantActivity[],
): CompactLivePreview {
	const liveActivity = pickCompactLiveActivity(activities);
	let latestThought: Extract<AssistantActivity, { type: "thinking" }> | null =
		null;
	for (let index = activities.length - 1; index >= 0; index -= 1) {
		const item = activities[index];
		if (item?.type === "thinking" && lastThinkingLine(item.text).length > 0) {
			latestThought = item;
			break;
		}
	}
	if (
		latestThought &&
		liveActivity?.type === "thinking" &&
		latestThought.id === liveActivity.id
	) {
		latestThought = null;
	}
	return { latestThought, liveActivity };
}

export type ActiveCompactSections = {
	work: AssistantContentItem[];
	/** The answer shown under the header, its settled work following it. */
	trailingText: AssistantContentItem[];
};

/**
 * Splits a streaming turn's content for compact output: while any activity is
 * running everything stays inside the compact work region; once activities
 * settle and trailing answer text begins streaming, that trailing text renders
 * directly underneath the compact work header. A stopped turn keeps the
 * answer it had shown outside the folded work, its settled work trailing it.
 */
export function splitActiveCompactContent(
	content: readonly AssistantContentItem[] | undefined,
	live = true,
): ActiveCompactSections {
	const items = content ?? [];
	if (items.length === 0) return { work: [], trailingText: [] };

	const hasRunningActivity = items.some(
		(item) => item.type !== "text" && item.status === "running",
	);
	if (hasRunningActivity) {
		return { work: [...items], trailingText: [] };
	}

	let trailingStart = items.length;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		if (items[index]?.type !== "text") break;
		trailingStart = index;
	}
	if (trailingStart === 0 || trailingStart === items.length) {
		return { work: [...items], trailingText: [] };
	}

	const trailingText = items.slice(trailingStart) as AssistantTextContent[];
	const hasVisibleTrailingText = trailingText.some(
		(item) => item.text.trim().length > 0,
	);
	if (!hasVisibleTrailingText) {
		return { work: [...items], trailingText: [] };
	}

	// A stopped turn keeps its answer text, and any settled work after it,
	// below the header: the work before the answer is what folds.
	if (!live) {
		let answerStart = trailingStart;
		while (answerStart > 0 && items[answerStart - 1]?.type !== "text") {
			answerStart -= 1;
		}
		if (answerStart === 0) return { work: [...items], trailingText: [] };
		return {
			work: items.slice(0, answerStart),
			trailingText: items.slice(answerStart),
		};
	}

	return {
		work: items.slice(0, trailingStart),
		trailingText,
	};
}

export function getAssistantActivities(
	content: readonly AssistantContentItem[] | undefined,
): AssistantActivity[] {
	return (content ?? []).filter(
		(item): item is AssistantActivity => item.type !== "text",
	);
}

/**
 * Keep assistant narration readable while a turn is active. Thinking/tool
 * groups manage their own disclosure state in the renderer, so active turns do
 * not move earlier assistant text behind the top-level work disclosure.
 *
 * Once the turn is finished, preserve the existing transcript shape: all
 * pre-final work (including intermediate narration) is folded behind the work
 * disclosure and only the final contiguous text run stays expanded.
 *
 * A turn that ended with an error or was interrupted has no final text run to
 * anchor the fold, but still folds all work so the terminal notice stands alone
 * below the collapsed activity.
 */
export function splitAssistantContentForDisplay(
	content: AssistantContentItem[] | undefined,
	isTurnFinished: boolean,
	foldWorkOnError = false,
): AssistantContentDisplaySections {
	const items = content ?? [];
	if (items.length <= 1) {
		return { work: [], final: items, hasCollapsedWork: false };
	}

	if (!isTurnFinished) {
		return { work: [], final: items, hasCollapsedWork: false };
	}

	let finalTextStart = items.length;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		if (items[index]?.type !== "text") break;
		finalTextStart = index;
	}

	if (finalTextStart === 0) {
		return { work: [], final: items, hasCollapsedWork: false };
	}

	if (finalTextStart === items.length) {
		return foldWorkOnError
			? { work: items, final: [], hasCollapsedWork: true }
			: { work: [], final: items, hasCollapsedWork: false };
	}

	const final = items.slice(finalTextStart);
	const hasVisibleFinalText = final.some(
		(item) => item.type === "text" && item.text.trim().length > 0,
	);
	if (!hasVisibleFinalText) {
		return foldWorkOnError
			? { work: items, final: [], hasCollapsedWork: true }
			: { work: [], final: items, hasCollapsedWork: false };
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
		// Only the streaming tail may differ; a mismatch earlier means the snapshot
		// covers a different span of the turn, and slicing would garble the text.
		if (remainingTextItems > 0 && nextText !== item.text) return items;
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
	startedAtMs?: number,
): AssistantContentItem[] {
	const items = content ?? [];
	const last = items[items.length - 1];
	if (last?.type === "thinking" && last.status === "running") return items;
	return [
		...items,
		{
			id: createId(),
			type: "thinking",
			text: "",
			status: "running",
			startedAtMs,
		},
	];
}

export function appendAssistantThinkingContent(
	content: AssistantContentItem[] | undefined,
	delta: string,
	createId: () => string,
	startedAtMs?: number,
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
		{
			id: createId(),
			type: "thinking",
			text: delta,
			status: "running",
			startedAtMs,
		},
	];
}

export function finishAssistantThinkingContent(
	content: AssistantContentItem[] | undefined,
	endedAtMs?: number,
): AssistantContentItem[] {
	const items = content ?? [];
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item.type === "thinking" && item.status === "running") {
			const next = [...items];
			next[index] = { ...item, status: "complete", endedAtMs };
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

export type AssistantPendingStatus = "starting" | "sending";
export type AssistantStreamingState =
	| AssistantPendingStatus
	| "waitingResponse"
	| "thinking"
	| "processing";

export function getAssistantStreamingState({
	text,
	activity,
	streaming,
	emptyState = "starting",
}: {
	text: string;
	activity?: readonly AssistantActivity[];
	streaming?: boolean;
	emptyState?: AssistantPendingStatus | "waitingResponse" | null;
}): AssistantStreamingState | null {
	if (!streaming) return null;
	const items = activity ?? [];
	if (!text && items.length === 0) return emptyState;
	if (
		items.some((item) => item.type === "thinking" && item.status === "running")
	) {
		return "thinking";
	}
	return "processing";
}
