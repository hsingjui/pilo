import type { SidebarSession } from "@/components/sidebar/types";
import type { Connection } from "@/lib/api/pi-runtime-types";
import type { Project } from "@/lib/api/projects-types";
import type { SessionIndexEntry } from "@/lib/api/sessions-types";
import { type AppState, isSessionUnread } from "../state/app-state";

/** A connection and its projects, as the sidebar groups them. */
export type SidebarGroup = { connection: Connection; projects: Project[] };

/** The projects by connection, in their own order, the local one first. */
export function sidebarGroups(projects: readonly Project[]): SidebarGroup[] {
	const groups = new Map<string, SidebarGroup>();
	for (const project of projects) {
		const { connection } = project;
		const group = groups.get(connection.id);
		if (group) group.projects.push(project);
		else groups.set(connection.id, { connection, projects: [project] });
	}
	return [...groups.values()].sort(
		(a, b) => Number(isLocal(b.connection)) - Number(isLocal(a.connection)),
	);
}

export function isLocal(connection: Connection) {
	return connection.kind.type === "local";
}

/** The storage key of a connection's section; expanded until collapsed. */
export function connectionSection(connectionId: string) {
	return `env:${connectionId}`;
}

/** The storage key of a project's section; collapsed until expanded. */
export function projectSection(projectId: string) {
	return `ws:${projectId}`;
}

/**
 * The saved sessions of a project as the sidebar lists them: which one is
 * running a turn and which has a finished turn the user has not seen.
 * `untitled` names a session that has no title and no first message.
 */
export function sidebarSessions(
	state: AppState,
	projectId: string,
	untitled: string,
): SidebarSession[] {
	const running = new Set(
		state.chatSessions
			.filter((chat) => chat.projectId === projectId && chat.activeTurn)
			.map((chat) => chat.sessionPath),
	);
	return (state.sessionIndexes[projectId]?.sessions ?? []).map((entry) => ({
		id: entry.piSessionId,
		title:
			entry.titleOverride ??
			entry.name ??
			entry.firstUserMessagePreview ??
			untitled,
		preview:
			entry.titleOverride || entry.name ? entry.firstUserMessagePreview : null,
		sessionPath: entry.sessionPath,
		projectId,
		latestMessageAt: latestMessageAt(entry),
		active: running.has(entry.sessionPath),
		unread: isSessionUnread(state, projectId, entry.sessionPath),
	}));
}

/** When the session's file last changed, else its last message's time. */
function latestMessageAt(entry: SessionIndexEntry) {
	const changedAtMs = Number(entry.fileMtimeNs) / 1_000_000;
	if (Number.isFinite(changedAtMs) && changedAtMs > 0) {
		return new Date(changedAtMs);
	}
	const date = new Date(
		entry.lastMessageAt ?? entry.updatedAt ?? entry.createdAt,
	);
	return Number.isNaN(date.getTime()) ? new Date(entry.indexedAtMs) : date;
}
