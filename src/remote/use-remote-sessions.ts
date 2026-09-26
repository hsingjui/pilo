import { useCallback, useEffect, useRef, useState } from "react";

import {
	sameStringSet,
	toProjectExternalActivity,
	type ProjectExternalActivity,
} from "@/components/app/app-session-index-model";
import type { PiloClientBootstrap } from "@/lib/pilo-client";
import type { Project } from "@/lib/projects";
import type { SessionIndexEntry } from "@/lib/sessions";
import type { WebPiloClient } from "./web-pilo-client";

// 外部 Pi 进程不会发出 Host 事件，只能像桌面端一样做低频兜底轮询。
const EXTERNAL_ACTIVITY_FALLBACK_POLL_MS = 15_000;

type UseRemoteSessionsOptions = {
	client: WebPiloClient | null;
	handleExpiredAuth: (error: unknown) => boolean;
	setFatalError: (message: string | null) => void;
	resyncKey: number;
};

export function useRemoteSessions({
	client,
	handleExpiredAuth,
	setFatalError,
	resyncKey,
}: UseRemoteSessionsOptions) {
	const [projects, setProjects] = useState<Project[]>([]);
	const [chatSessions, setChatSessions] = useState<
		PiloClientBootstrap["chatSessions"]
	>([]);
	const [rawSessions, setRawSessions] = useState<SessionIndexEntry[]>([]);
	const [externalActivity, setExternalActivity] = useState<
		ReadonlyMap<string, ProjectExternalActivity>
	>(() => new Map());
	const [refreshingProjectIds, setRefreshingProjectIds] = useState<
		ReadonlySet<string>
	>(() => new Set());
	const runtimeActivityRefreshTimerRef = useRef<number | null>(null);
	const reloadBootstrapRef = useRef<(() => Promise<void>) | null>(null);
	const refreshAllSessionsRef = useRef<(() => Promise<void>) | null>(null);

	const reloadBootstrap = useCallback(async () => {
		if (!client) return;
		try {
			const bootstrap = await client.bootstrap();
			setProjects(bootstrap.projects);
			setChatSessions(bootstrap.chatSessions);
			setFatalError(null);
		} catch (error) {
			if (!handleExpiredAuth(error)) {
				setFatalError(error instanceof Error ? error.message : String(error));
			}
		}
	}, [client, handleExpiredAuth, setFatalError]);

	const refreshProjectSessions = useCallback(
		async (projectId: string, showProgress = false) => {
			if (!client) return;
			if (showProgress) {
				setRefreshingProjectIds((current) => {
					if (current.has(projectId)) return current;
					const next = new Set(current);
					next.add(projectId);
					return next;
				});
			}
			try {
				const next = await client.listSessions(projectId);
				setRawSessions((current) => [
					...current.filter((session) => session.projectId !== projectId),
					...next,
				]);
			} catch (error) {
				if (!handleExpiredAuth(error)) {
					console.debug("Failed to refresh remote sessions", error);
				}
			} finally {
				if (showProgress) {
					setRefreshingProjectIds((current) => {
						if (!current.has(projectId)) return current;
						const next = new Set(current);
						next.delete(projectId);
						return next;
					});
				}
			}
		},
		[client, handleExpiredAuth],
	);

	const refreshAllSessions = useCallback(async () => {
		if (!client || projects.length === 0) {
			setRawSessions([]);
			return;
		}
		const results = await Promise.allSettled(
			projects.map((project) => client.listSessions(project.id)),
		);
		const next: SessionIndexEntry[] = [];
		for (const result of results) {
			if (result.status === "fulfilled") next.push(...result.value);
		}
		setRawSessions(next);
	}, [client, projects]);

	const refreshExternalActivity = useCallback(
		async (projectId: string) => {
			if (!client) return;
			try {
				const activities = await client.externalActivity(projectId);
				const nextActivity = toProjectExternalActivity(activities);
				setExternalActivity((current) => {
					const previous = current.get(projectId);
					if (
						previous &&
						sameStringSet(previous.openTurnPaths, nextActivity.openTurnPaths)
					) {
						return current;
					}
					const nextMap = new Map(current);
					if (nextActivity.openTurnPaths.size === 0) nextMap.delete(projectId);
					else nextMap.set(projectId, nextActivity);
					return nextMap;
				});
			} catch (error) {
				if (!handleExpiredAuth(error)) {
					console.debug("Failed to inspect external Pi activity", error);
				}
			}
		},
		[client, handleExpiredAuth],
	);

	const isExternalOpenTurn = useCallback(
		(projectId: string, sessionPath: string) =>
			externalActivity.get(projectId)?.openTurnPaths.has(sessionPath) ?? false,
		[externalActivity],
	);

	useEffect(() => {
		refreshAllSessionsRef.current = refreshAllSessions;
	}, [refreshAllSessions]);

	// Debounced Host chat-session refresh so the sidebar running/unread markers
	// track every session, not just the visible one. ponytail: refetch bootstrap on
	// activity bursts; add a Host activity endpoint if this proves heavy.
	const scheduleRuntimeActivityRefresh = useCallback(() => {
		if (runtimeActivityRefreshTimerRef.current !== null) return;
		runtimeActivityRefreshTimerRef.current = window.setTimeout(() => {
			runtimeActivityRefreshTimerRef.current = null;
			void reloadBootstrapRef.current?.();
		}, 120);
	}, []);

	useEffect(() => {
		reloadBootstrapRef.current = reloadBootstrap;
	}, [reloadBootstrap]);

	useEffect(
		() => () => {
			if (runtimeActivityRefreshTimerRef.current !== null) {
				window.clearTimeout(runtimeActivityRefreshTimerRef.current);
			}
		},
		[],
	);

	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- Bootstrap and the resync generation intentionally retrigger synchronization with the external Remote Host snapshot. */
	useEffect(() => {
		void resyncKey;
		void reloadBootstrap();
	}, [reloadBootstrap, resyncKey]);
	useEffect(() => {
		void resyncKey;
		void refreshAllSessions();
	}, [refreshAllSessions, resyncKey]);

	// 外部会话开关不会触发 Host 事件，靠轮询兜底，让侧栏与打开的会话跟上状态。
	useEffect(() => {
		if (!client || projects.length === 0) {
			setExternalActivity(new Map());
			return;
		}
		const run = () => {
			for (const project of projects) {
				void refreshExternalActivity(project.id);
			}
		};
		run();
		const timer = window.setInterval(run, EXTERNAL_ACTIVITY_FALLBACK_POLL_MS);
		return () => window.clearInterval(timer);
	}, [client, projects, refreshExternalActivity]);
	/* oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies */

	return {
		projects,
		chatSessions,
		rawSessions,
		setRawSessions,
		externalActivity,
		isExternalOpenTurn,
		refreshingProjectIds,
		reloadBootstrap,
		refreshProjectSessions,
		refreshAllSessions,
		scheduleRuntimeActivityRefresh,
	};
}
