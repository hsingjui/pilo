import type { SidebarSession } from "./types";

export const SIDEBAR_RECENT_SESSION_LIMIT = 5;

/**
 * 排序键只在状态切换时变化：运行中的会话按进入运行状态的时刻排（组内稳定，
 * 不会随消息流来回跳），空闲会话按最近消息时间排。缺失 runningSince 时
 * （仅测试或极端同毫秒竞态）回退到最近消息时间。
 */
function compareSessionRecency(a: SidebarSession, b: SidebarSession) {
	const aActive = Boolean(a.active);
	const bActive = Boolean(b.active);
	if (aActive !== bActive) return aActive ? -1 : 1;
	if (aActive) {
		return (
			(b.runningSince?.getTime() ?? 0) - (a.runningSince?.getTime() ?? 0) ||
			b.latestMessageAt.getTime() - a.latestMessageAt.getTime()
		);
	}
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
	};
}

export function sortSidebarSessionsActiveFirst(
	sessions: readonly SidebarSession[],
): SidebarSession[] {
	return sortSidebarSessionsByRecency(sessions);
}
