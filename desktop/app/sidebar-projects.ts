import { sortSidebarSessionsActiveFirst } from "@shared/sidebar/session-list";
import type { SidebarSession } from "@shared/sidebar/sidebar-types";
import type { Connection } from "@shared/api/pi-runtime-types";
import type { Project } from "@shared/api/projects-types";
import type { SessionIndexEntry } from "@shared/api/sessions-types";
import { type AppState, isSessionUnread } from "../state/app-state";

/** A connection and its projects, as the sidebar groups them. */
export type SidebarGroup = { connection: Connection; projects: Project[] };

/**
 * The projects by connection, in their own order, the local one first. Each
 * group follows the connection's saved order; projects it does not name keep
 * their catalog places after the ordered ones.
 */
export function sidebarGroups(
	projects: readonly Project[],
	order: Record<string, readonly string[]> = {},
): SidebarGroup[] {
	const groups = new Map<string, SidebarGroup>();
	for (const project of projects) {
		const { connection } = project;
		const group = groups.get(connection.id);
		if (group) group.projects.push(project);
		else groups.set(connection.id, { connection, projects: [project] });
	}
	for (const group of groups.values()) {
		const saved = order[group.connection.id];
		if (saved) group.projects = bySavedOrder(group.projects, saved);
	}
	return [...groups.values()].sort(
		(a, b) => Number(isLocal(b.connection)) - Number(isLocal(a.connection)),
	);
}

function bySavedOrder(
	projects: readonly Project[],
	order: readonly string[],
): Project[] {
	const rank = new Map(order.map((id, index) => [id, index]));
	return [...projects].sort(
		(a, b) =>
			(rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
			(rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
	);
}

/**
 * The connection's project order with the project moved one place, or null
 * when it cannot move (the edge or not in the list).
 */
export function movedProjectOrder(
	projects: readonly Project[],
	projectId: string,
	delta: -1 | 1,
): string[] | null {
	const from = projects.findIndex((project) => project.id === projectId);
	const to = from + delta;
	if (from < 0 || to < 0 || to >= projects.length) return null;
	const order = projects.map((project) => project.id);
	[order[from], order[to]] = [order[to], order[from]];
	return order;
}

export function isLocal(connection: Connection) {
	return connection.kind.type === "local";
}

/** The storage key of a connection's section; expanded until collapsed. */
export function connectionSection(connectionId: string) {
	return `env:${connectionId}`;
}

/** The storage key of a project's section; collapsed until expanded. */
/** The key of the recent view's one section. */
export const RECENT_SECTION = "recent";

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

/** How many sessions the recent view lists, as in the Tauri app. */
const RECENT_SESSION_LIMIT = 50;

/** The latest sessions of every project: the running ones, then by time. */
export function recentSessions(state: AppState, untitled: string) {
	return sortSidebarSessionsActiveFirst(
		state.projects.flatMap((project) =>
			sidebarSessions(state, project.id, untitled),
		),
	).slice(0, RECENT_SESSION_LIMIT);
}
