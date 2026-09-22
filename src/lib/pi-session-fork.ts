import { i18n } from "../i18n/index.ts";
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
			throw new Error(i18n.t("errors.forkBranchLoop"));
		}
		visited.add(currentId);
		const entry = byId.get(currentId);
		if (!entry) {
			throw new Error(i18n.t("errors.forkMissingParent"));
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
		throw new Error(i18n.t("errors.forkTargetNotFound"));
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
			throw new Error(i18n.t("errors.sessionChanged"));
		}
		return { type: "clone" };
	}

	let nextUserOrdinal = -1;
	for (let index = 0; index <= nextUserIndex; index += 1) {
		if (messages[index]?.role === "user") nextUserOrdinal += 1;
	}

	const nextUserEntry = activeUserEntries[nextUserOrdinal];
	if (!nextUserEntry) {
		throw new Error(i18n.t("errors.forkBranchPointNotFound"));
	}

	return { type: "fork", entryId: nextUserEntry.id };
}
