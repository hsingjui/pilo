import { readChatMentionParts } from "@/lib/chat/chat-mentions";
import type { SessionMention } from "@/lib/chat/session-mentions";

const EMPTY_SESSIONS: ReadonlyMap<string, SessionMention> = new Map();

// Keep ownership across composer remounts, but never adopt existing/history files.
const pendingFiles = new Map<string, () => Promise<void>>();

export function registerChatFile(path: string, remove: () => Promise<void>) {
	pendingFiles.set(path, remove);
	return path;
}

export function discardChatFiles(paths: readonly string[]) {
	for (const path of paths) {
		const remove = pendingFiles.get(path);
		if (!remove) continue;
		pendingFiles.delete(path);
		void remove().catch((error: unknown) => {
			console.warn("Failed to clean up chat attachment", error);
		});
	}
}

function filePaths(text: string) {
	return readChatMentionParts(text, EMPTY_SESSIONS).flatMap(({ mention }) =>
		mention?.kind === "file" ? [mention.path] : [],
	);
}

export function discardRemovedChatFiles(previous: string, next: string) {
	const remaining = new Set(filePaths(next));
	discardChatFiles(filePaths(previous).filter((path) => !remaining.has(path)));
}

/** Protect submissions before handing them to async commands, queues or recovery. */
export function retainChatFiles(text: string) {
	for (const path of filePaths(text)) pendingFiles.delete(path);
}
