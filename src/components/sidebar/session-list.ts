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

	let recentCount = 0;
	for (const session of ordered) {
		if (included.has(session.id)) continue;
		// 选中的会话留在原本的时间位置：只保证可见，不因为点击而被顶到项目第一位。
		const selected = session.id === selectedSessionId;
		if (!selected && recentCount >= recentLimit) continue;
		include(session);
		if (!selected) recentCount += 1;
	}

	return {
		visible,
		hiddenCount: Math.max(0, sessions.length - visible.length),
		totalCount: sessions.length,
	};
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
