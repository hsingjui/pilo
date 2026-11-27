import { sortSidebarSessionsActiveFirst } from "@shared/sidebar/session-list";
import type { SidebarSession } from "@shared/sidebar/sidebar-types";
import type { Connection } from "@shared/api/pi-runtime-types";
import type { Project } from "@shared/api/projects-types";
import type { SessionIndexEntry } from "@shared/api/sessions-types";
import {
	chatRuntimeShowsActivity,
	runtimeSessionIdFromKey,
	runtimeSessionPathKey,
} from "@shared/chat/chat-session-runtime-model";
import { type AppState, isSessionUnread } from "../state/app-state";

/** A connection and its projects, as the sidebar groups them. */
export type SidebarGroup = { connection: Connection; projects: Project[] };

/**
 * The projects by visible connection, the local one first. Each group follows
 * the connection's saved order; projects it does not name keep their catalog
 * places after the ordered ones.
 */
export function sidebarGroups(
	projects: readonly Project[],
	order: Record<string, readonly string[]> = {},
): SidebarGroup[] {
	const groups = new Map<string, SidebarGroup>();
	for (const project of projects) {
		const { connection } = project;
		if (connection.shownInHome === false) continue;
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
 * The sessions of a project: new chats with a confirmed prompt, then saved
 * sessions, marked running or with a finished turn the user has not seen.
 */
export function sidebarSessions(
	state: AppState,
	projectId: string,
	untitled: string,
): SidebarSession[] {
	// Since when each saved session runs, by `runtimeSessionPathKey` of its file.
	const running = new Map<string, number>();
	for (const chat of state.chatSessions) {
		if (
			chat.projectId === projectId &&
			chat.sessionPath &&
			chatRuntimeShowsActivity(chat)
		) {
			running.set(
				runtimeSessionPathKey(chat.sessionPath),
				state.runningSince[chat.sessionKey] ?? 0,
			);
		}
	}
	// Turns an external Pi runs, as the WebUI sidebar shows them.
	for (const [path, since] of Object.entries(
		state.externalActivity[projectId] ?? {},
	)) {
		if (!running.has(path)) running.set(path, since);
	}
	const entries = state.sessionIndexes[projectId]?.sessions ?? [];
	const saved = entries.map((entry) =>
		savedSession(
			entry,
			projectId,
			untitled,
			running.get(runtimeSessionPathKey(entry.sessionPath)),
			isSessionUnread(state, projectId, entry.sessionPath),
		),
	);
	const unsaved = unsavedSessions(state, projectId, untitled);
	return unsaved.length > 0 ? [...unsaved, ...saved] : saved;
}

/** The rows last made for saved entries, reused while they still hold. */
const savedRows = new WeakMap<SessionIndexEntry, SidebarSession>();

/** The rows last made for unsaved draft sessions, keyed by sessionKey. */
const unsavedRows = new Map<string, SidebarSession>();

function reuseUnsavedRow(
	cacheKey: string,
	id: string,
	title: string,
	projectId: string,
	latestMessageMs: number,
	active: boolean,
	runningSinceMs: number | undefined,
): SidebarSession {
	const cached = unsavedRows.get(cacheKey);
	if (
		cached &&
		cached.id === id &&
		cached.title === title &&
		cached.projectId === projectId &&
		cached.latestMessageAt.getTime() === latestMessageMs &&
		cached.active === active &&
		cached.runningSince?.getTime() === runningSinceMs
	) {
		return cached;
	}
	const latestMessageAt = new Date(latestMessageMs);
	const row: SidebarSession = {
		id,
		title,
		preview: null,
		sessionPath: "",
		projectId,
		latestMessageAt,
		active,
		runningSince:
			runningSinceMs !== undefined
				? runningSinceMs === latestMessageMs
					? latestMessageAt
					: new Date(runningSinceMs)
				: undefined,
	};
	if (unsavedRows.size > 128) unsavedRows.clear();
	unsavedRows.set(cacheKey, row);
	return row;
}

/**
 * One saved session's row. A rescan keeps unchanged entries, so their rows
 * are the same objects and the list updates them in place.
 */
function savedSession(
	entry: SessionIndexEntry,
	projectId: string,
	untitled: string,
	runningSince: number | undefined,
	unread: boolean,
): SidebarSession {
	const title =
		entry.titleOverride ??
		entry.name ??
		entry.firstUserMessagePreview ??
		untitled;
	const active = runningSince !== undefined;
	const cached = savedRows.get(entry);
	if (
		cached &&
		cached.projectId === projectId &&
		cached.title === title &&
		cached.active === active &&
		cached.unread === unread &&
		cached.runningSince?.getTime() === runningSince
	) {
		return cached;
	}
	const row: SidebarSession = {
		id: entry.piSessionId,
		title,
		preview:
			entry.titleOverride || entry.name ? entry.firstUserMessagePreview : null,
		sessionPath: entry.sessionPath,
		projectId,
		latestMessageAt: latestMessageAt(entry),
		active,
		runningSince:
			runningSince !== undefined ? new Date(runningSince) : undefined,
		unread,
	};
	savedRows.set(entry, row);
	return row;
}

/** Confirmed chats whose files have not reached the index yet. */
function unsavedSessions(
	state: AppState,
	projectId: string,
	untitled: string,
): SidebarSession[] {
	const rows: SidebarSession[] = [];
	for (const [key, draft] of state.sentDrafts ?? []) {
		if (draft.projectId !== projectId) continue;
		const sessionId = runtimeSessionIdFromKey(key, projectId);
		if (!sessionId) continue;
		const chat = state.chatSessions.find((held) => held.sessionKey === key);
		const active =
			state.pendingDrafts.has(key) || chatRuntimeShowsActivity(chat);
		rows.push(
			reuseUnsavedRow(
				key,
				sessionId,
				draft.title || untitled,
				projectId,
				draft.startedAt,
				active,
				active ? (state.runningSince[key] ?? draft.startedAt) : undefined,
			),
		);
	}
	return rows;
}

/** The key a list keeps a session's row by: its file, or a new chat's id. */
export function sessionRowKey(session: SidebarSession) {
	return `${session.projectId}:${session.sessionPath || session.id}`;
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

/** How many sessions the recent view lists, as in the WebUI. */
const RECENT_SESSION_LIMIT = 50;

/** The latest sessions of every project: the running ones, then by time. */
export function recentSessions(state: AppState, untitled: string) {
	return sortSidebarSessionsActiveFirst(
		state.projects.flatMap((project) =>
			sidebarSessions(state, project.id, untitled),
		),
	).slice(0, RECENT_SESSION_LIMIT);
}
