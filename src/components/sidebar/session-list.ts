import type { SidebarSession } from "./types";

export const SIDEBAR_RECENT_SESSION_LIMIT = 5;

function compareSessionRecency(a: SidebarSession, b: SidebarSession) {
	return b.latestMessageAt.getTime() - a.latestMessageAt.getTime();
}

export function sortSidebarSessionsByRecency(
	sessions: readonly SidebarSession[],
): SidebarSession[] {
	/* oxlint-disable-next-line unicorn/no-array-sort -- clone first so the caller's session order stays immutable. */
	return [...sessions].sort(compareSessionRecency);
}

export function summarizeProjectSessions(
	sessions: readonly SidebarSession[],
	selectedSessionId: string | null,
	recentLimit = SIDEBAR_RECENT_SESSION_LIMIT,
) {
	const ordered = sortSidebarSessionsByRecency(sessions);
	const visible: SidebarSession[] = [];
	const included = new Set<string>();

	const include = (session: SidebarSession | undefined) => {
		if (!session || included.has(session.id)) return;
		included.add(session.id);
		visible.push(session);
	};

	// 运行中的会话置顶，保证它们不会因为超出最近窗口而被隐藏。
	for (const session of ordered) {
		if (session.active) include(session);
	}

	const recent = ordered
		.filter((session) => !included.has(session.id))
		.slice(0, recentLimit);
	const selected = ordered.find(
		(session) => session.id === selectedSessionId && !included.has(session.id),
	);
	if (selected && !recent.some((session) => session.id === selected.id)) {
		// 选中的旧会话需要继续可见，但不能因为一次点击把“最近 5 条”
		// 扩成 6 条；用它替换最近窗口里最旧的一条即可。
		if (recent.length > 0) recent[recent.length - 1] = selected;
		else recent.push(selected);
	}
	for (const session of recent) include(session);

	return {
		visible,
		hiddenCount: Math.max(0, sessions.length - visible.length),
		totalCount: sessions.length,
	};
}

export function sortSidebarSessionsActiveFirst(
	sessions: readonly SidebarSession[],
): SidebarSession[] {
	/* oxlint-disable-next-line unicorn/no-array-sort -- clone first so the caller's session order stays immutable. */
	return [...sessions].sort((a, b) => {
		if (Boolean(a.active) !== Boolean(b.active)) {
			return a.active ? -1 : 1;
		}
		return b.latestMessageAt.getTime() - a.latestMessageAt.getTime();
	});
}

export function filterProjectSessions(
	sessions: readonly SidebarSession[],
	query: string,
): SidebarSession[] {
	const normalizedQuery = query.trim().toLowerCase();
	const ordered = sortSidebarSessionsByRecency(sessions);
	if (!normalizedQuery) return ordered;

	return ordered.filter((session) => {
		const searchable =
			`${session.title}\n${session.preview ?? ""}`.toLowerCase();
		return searchable.includes(normalizedQuery);
	});
}
