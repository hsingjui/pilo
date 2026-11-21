import { sortSidebarSessionsActiveFirst } from "@shared/sidebar/session-list";
import type { SidebarSession } from "@shared/sidebar/sidebar-types";
import { chatSessionKey } from "@shared/api/chat-session-key";
import type { Connection } from "@shared/api/pi-runtime-types";
import type { Project } from "@shared/api/projects-types";
import type { SessionIndexEntry } from "@shared/api/sessions-types";
import {
	chatRuntimeShowsActivity,
	runtimeSessionIdFromKey,
	runtimeSessionPathKey,
} from "@shared/chat/chat-session-runtime-model";
import {
	type AppState,
	isDraftSessionId,
	isSessionUnread,
} from "../state/app-state";
import type { StartedDraft } from "../state/app-store";

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
 * The sessions of a project as the sidebar lists them: its new chats Pi has
 * not saved yet, as the Tauri app lists its opened chats, then its saved
 * ones, each marked running or with a finished turn the user has not seen.
 * `untitled` names a session that has no title and no first message;
 * `draft` is the open new chat once a prompt was sent from it.
 */
export function sidebarSessions(
	state: AppState,
	projectId: string,
	untitled: string,
	draft?: StartedDraft | null,
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
	// Turns an external Pi runs, as the Tauri sidebar shows them.
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
	const unsaved = unsavedSessions(state, projectId, untitled, draft, entries);
	return unsaved.length > 0 ? [...unsaved, ...saved] : saved;
}

/** The rows last made for saved entries, reused while they still hold. */
const savedRows = new WeakMap<SessionIndexEntry, SidebarSession>();

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

/**
 * New chats of the project that Pi has not saved to an indexed file yet:
 * the open one once a prompt was sent, and others still running a turn.
 * Their `sessionPath` is empty; their `id` is the draft's session id.
 */
function unsavedSessions(
	state: AppState,
	projectId: string,
	untitled: string,
	draft: StartedDraft | null | undefined,
	entries: readonly SessionIndexEntry[],
): SidebarSession[] {
	const rows: SidebarSession[] = [];
	const open = state.navigation.session;
	const openKey =
		open?.projectId === projectId && open.sessionId !== undefined
			? chatSessionKey(projectId, open.sessionId)
			: null;
	if (openKey && open?.sessionId && draft) {
		const chat = state.chatSessions.find((held) => held.sessionKey === openKey);
		const since = state.runningSince[openKey] ?? draft.startedAt;
		rows.push({
			id: open.sessionId,
			title: draft.title || untitled,
			preview: null,
			sessionPath: "",
			projectId,
			latestMessageAt: new Date(draft.startedAt),
			active: draft.active || chatRuntimeShowsActivity(chat),
			runningSince: new Date(since),
		});
	}
	let indexed: Set<string> | undefined;
	for (const chat of state.chatSessions) {
		if (
			chat.projectId !== projectId ||
			chat.sessionKey === openKey ||
			!chatRuntimeShowsActivity(chat)
		) {
			continue;
		}
		const sessionId = runtimeSessionIdFromKey(chat.sessionKey, projectId);
		if (!sessionId || !isDraftSessionId(sessionId)) continue;
		indexed ??= new Set(
			entries.map((entry) => runtimeSessionPathKey(entry.sessionPath)),
		);
		if (
			chat.sessionPath &&
			indexed.has(runtimeSessionPathKey(chat.sessionPath))
		)
			continue;
		const since = new Date(state.runningSince[chat.sessionKey] ?? 0);
		rows.push({
			id: sessionId,
			title: untitled,
			preview: null,
			sessionPath: "",
			projectId,
			latestMessageAt: since,
			active: true,
			runningSince: since,
		});
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

/** How many sessions the recent view lists, as in the Tauri app. */
const RECENT_SESSION_LIMIT = 50;

/** The latest sessions of every project: the running ones, then by time. */
export function recentSessions(
	state: AppState,
	untitled: string,
	draft?: StartedDraft | null,
) {
	return sortSidebarSessionsActiveFirst(
		state.projects.flatMap((project) =>
			sidebarSessions(state, project.id, untitled, draft),
		),
	).slice(0, RECENT_SESSION_LIMIT);
}
