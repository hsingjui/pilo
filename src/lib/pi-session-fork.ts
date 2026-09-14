import type { ChatMessage } from "@/lib/conversation-types";
import type { PiSessionEntries, PiSessionEntry } from "@/lib/pi-runtime";

export type PiAssistantForkTarget =
	| { type: "clone" }
	| { type: "fork"; entryId: string };

export function getActivePiBranch({
	entries,
	leafId,
}: PiSessionEntries): PiSessionEntry[] {
	if (!leafId) return [];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: PiSessionEntry[] = [];
	const visited = new Set<string>();
	let currentId: string | null = leafId;

	while (currentId) {
		if (visited.has(currentId)) {
			throw new Error("Pi 会话分支包含循环引用。");
		}
		visited.add(currentId);
		const entry = byId.get(currentId);
		if (!entry) {
			throw new Error("Pi 会话分支缺少父级消息。");
		}
		branch.push(entry);
		currentId = entry.parentId;
	}

	branch.reverse();
	return branch;
}

export function resolveAssistantForkTarget(
	messages: readonly ChatMessage[],
	assistantMessageId: string,
	sessionEntries: PiSessionEntries,
): PiAssistantForkTarget {
	const assistantIndex = messages.findIndex(
		(message) =>
			message.id === assistantMessageId && message.role === "assistant",
	);
	if (assistantIndex < 0) {
		throw new Error("找不到要 Fork 的 Agent 回复。");
	}

	const activeUserEntries = getActivePiBranch(sessionEntries).filter(
		(entry) => entry.type === "message" && entry.message?.role === "user",
	);
	const nextUserIndex = messages.findIndex(
		(message, index) => index > assistantIndex && message.role === "user",
	);
	if (nextUserIndex < 0) {
		const visibleUserCount = messages.filter(
			(message) => message.role === "user",
		).length;
		if (activeUserEntries.length !== visibleUserCount) {
			throw new Error("当前会话已发生变化，请刷新后再 Fork。");
		}
		return { type: "clone" };
	}

	let nextUserOrdinal = -1;
	for (let index = 0; index <= nextUserIndex; index += 1) {
		if (messages[index]?.role === "user") nextUserOrdinal += 1;
	}

	const nextUserEntry = activeUserEntries[nextUserOrdinal];
	if (!nextUserEntry) {
		throw new Error("无法定位该回复之后的 Pi 分支点，请刷新会话后重试。");
	}

	return { type: "fork", entryId: nextUserEntry.id };
}
