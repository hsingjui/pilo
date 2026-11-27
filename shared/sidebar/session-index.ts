import type { SessionIndexEntry } from "@shared/api/sessions-types";

export function sameSessionIndexEntry(
	a: SessionIndexEntry,
	b: SessionIndexEntry,
) {
	return (
		a.connectionId === b.connectionId &&
		a.projectId === b.projectId &&
		a.piSessionId === b.piSessionId &&
		a.sessionPath === b.sessionPath &&
		a.name === b.name &&
		a.cwd === b.cwd &&
		a.createdAt === b.createdAt &&
		a.updatedAt === b.updatedAt &&
		a.messageCount === b.messageCount &&
		a.lastMessageAt === b.lastMessageAt &&
		a.firstUserMessagePreview === b.firstUserMessagePreview &&
		a.fileSize === b.fileSize &&
		a.fileMtimeNs === b.fileMtimeNs &&
		a.lastOffset === b.lastOffset &&
		a.pinned === b.pinned &&
		a.titleOverride === b.titleOverride &&
		(a.archivedAt ?? null) === (b.archivedAt ?? null)
	);
}

/**
 * `next` with the entries of `previous` that did not change in their place,
 * or `previous` itself when nothing did, so a rescan updates the sidebar in
 * place instead of rebuilding every row.
 */
export function reuseSessionEntries(
	previous: SessionIndexEntry[],
	next: SessionIndexEntry[],
) {
	const previousByPath = new Map(
		previous.map((session) => [session.sessionPath, session] as const),
	);
	const reused = next.map((session) => {
		const held = previousByPath.get(session.sessionPath);
		return held && sameSessionIndexEntry(held, session) ? held : session;
	});
	return reused.length === previous.length &&
		reused.every((session, index) => session === previous[index])
		? previous
		: reused;
}

/** Replaces one project's sessions in `current`, keeping unchanged entries. */
export function mergeProjectSessions(
	current: SessionIndexEntry[],
	projectId: string,
	sessions: SessionIndexEntry[],
) {
	const others = current.filter((session) => session.projectId !== projectId);
	const previous = current.filter((session) => session.projectId === projectId);
	const merged = [...others, ...reuseSessionEntries(previous, sessions)];
	return merged.length === current.length &&
		merged.every((session, index) => session === current[index])
		? current
		: merged;
}
