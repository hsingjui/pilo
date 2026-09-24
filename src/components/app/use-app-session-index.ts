import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type Dispatch,
	type SetStateAction,
} from "react";

import { toSidebarSession } from "@/components/app/app-chat-state";
import { listenRuntimeEvents } from "@/lib/pi-runtime";
import {
	deleteSession,
	getExternalSessionActivity,
	listSessions,
	listenSessionWatchEvents,
	reconcileSessions,
	startSessionWatch,
	stopSessionWatch,
	updateSessionUiState,
	type SessionExternalActivity,
	type SessionIndexEntry,
} from "@/lib/sessions";

type SessionUiUpdate = {
	title?: string;
};

type ProjectExternalActivity = {
	sessionPaths: ReadonlySet<string>;
	openTurnPaths: ReadonlySet<string>;
};

const EMPTY_PATHS: ReadonlySet<string> = new Set();

function toProjectExternalActivity(
	activities: readonly SessionExternalActivity[],
): ProjectExternalActivity {
	return {
		sessionPaths: new Set(activities.map((activity) => activity.path)),
		openTurnPaths: new Set(
			activities
				.filter((activity) => activity.turnOpen)
				.map((activity) => activity.path),
		),
	};
}

type ExternalActivitySetter = Dispatch<
	SetStateAction<ReadonlyMap<string, ProjectExternalActivity>>
>;

/** 拉取某项目的外部 Pi 运行状态并写入活动映射。 */
async function fetchProjectExternalActivity(
	projectId: string,
	setExternalActivity: ExternalActivitySetter,
) {
	try {
		const activities = await getExternalSessionActivity(projectId);
		setExternalActivity((current) => {
			const next = new Map(current);
			next.set(projectId, toProjectExternalActivity(activities));
			return next;
		});
	} catch (error) {
		console.debug("Failed to inspect external Pi activity", error);
	}
}

type IdleCapableWindow = Window & {
	requestIdleCallback?: (
		callback: () => void,
		options?: { timeout: number },
	) => number;
	cancelIdleCallback?: (handle: number) => void;
};

function sameSessionIndexEntry(a: SessionIndexEntry, b: SessionIndexEntry) {
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
		a.titleOverride === b.titleOverride
	);
}

function mergeProjectSessions(
	current: SessionIndexEntry[],
	projectId: string,
	sessions: SessionIndexEntry[],
) {
	const previousByPath = new Map(
		current
			.filter((session) => session.projectId === projectId)
			.map((session) => [session.sessionPath, session] as const),
	);
	const nextProjectSessions = sessions.map((session) => {
		const previous = previousByPath.get(session.sessionPath);
		return previous && sameSessionIndexEntry(previous, session)
			? previous
			: session;
	});
	const next = [
		...current.filter((session) => session.projectId !== projectId),
		...nextProjectSessions,
	];
	if (
		next.length === current.length &&
		next.every((session, index) => session === current[index])
	) {
		return current;
	}
	return next;
}

export function useAppSessionIndex(activeProjectId: string | null) {
	const [indexedSessions, setIndexedSessions] = useState<SessionIndexEntry[]>(
		[],
	);
	const [externalActivity, setExternalActivity] = useState<
		ReadonlyMap<string, ProjectExternalActivity>
	>(() => new Map());
	const [refreshingProjectIds, setRefreshingProjectIds] = useState<
		ReadonlySet<string>
	>(() => new Set());

	const replaceProjectSessions = useCallback(
		(projectId: string, sessions: SessionIndexEntry[]) => {
			setIndexedSessions((current) =>
				mergeProjectSessions(current, projectId, sessions),
			);
		},
		[],
	);

	const refreshExternalActivity = useCallback(
		(projectId: string) =>
			fetchProjectExternalActivity(projectId, setExternalActivity),
		[],
	);

	const refreshProjectSessions = useCallback(
		async (projectId: string, showProgress = false) => {
			if (showProgress) {
				setRefreshingProjectIds((current) => {
					if (current.has(projectId)) return current;
					const next = new Set(current);
					next.add(projectId);
					return next;
				});
			}
			try {
				// 并行重取会话索引与运行状态（外部 Pi 是否有未结束的 turn）。
				const [result] = await Promise.all([
					reconcileSessions(projectId),
					fetchProjectExternalActivity(projectId, setExternalActivity),
				]);
				setIndexedSessions((current) =>
					mergeProjectSessions(current, projectId, result.sessions),
				);
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
		[],
	);

	useEffect(() => {
		if (!activeProjectId) return;
		let disposed = false;
		let refreshTimer: number | undefined;
		let initialRefreshTimer: number | undefined;
		let initialRefreshIdleId: number | undefined;
		let watcherReady = false;
		let unlistenRuntime: (() => void) | undefined;
		let unlistenSessionWatch: (() => void) | undefined;
		let activityTimer: number | undefined;
		const idleWindow = window as IdleCapableWindow;

		const refresh = () => {
			void refreshProjectSessions(activeProjectId).catch((error) =>
				console.error("Failed to reconcile sessions", error),
			);
		};
		const queueRefresh = () => {
			if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
			refreshTimer = window.setTimeout(refresh, 120);
		};
		const scheduleInitialRefresh = () => {
			const run = () => {
				initialRefreshTimer = undefined;
				initialRefreshIdleId = undefined;
				if (!disposed) refresh();
			};
			if (idleWindow.requestIdleCallback) {
				initialRefreshIdleId = idleWindow.requestIdleCallback(run, {
					timeout: 1200,
				});
				return;
			}
			initialRefreshTimer = window.setTimeout(run, 0);
		};
		const refreshActivity = () => {
			void refreshExternalActivity(activeProjectId);
		};
		const scheduleActivityPoll = () => {
			if (activityTimer !== undefined) window.clearTimeout(activityTimer);
			activityTimer = window.setTimeout(() => {
				refreshActivity();
				scheduleActivityPoll();
			}, 1500);
		};
		const hydrateThenRefresh = async () => {
			try {
				const cached = await listSessions(activeProjectId);
				if (!disposed) replaceProjectSessions(activeProjectId, cached);
			} catch (error) {
				console.error("Failed to load cached sessions", error);
			}
			if (!disposed) scheduleInitialRefresh();
		};

		void hydrateThenRefresh();
		refreshActivity();
		scheduleActivityPoll();
		window.addEventListener("focus", queueRefresh);
		void listenRuntimeEvents((event) => {
			if (event.projectId && event.projectId !== activeProjectId) {
				if (event.type === "assistant_message_end") {
					void refreshProjectSessions(event.projectId).catch((error) =>
						console.error("Failed to refresh background sessions", error),
					);
				}
				return;
			}
			if (event.type === "assistant_message_end" && !watcherReady) {
				queueRefresh();
			}
		})
			.then((unlisten) => {
				if (disposed) unlisten();
				else unlistenRuntime = unlisten;
			})
			.catch((error) =>
				console.error("Failed to listen for runtime events", error),
			);
		void listenSessionWatchEvents((event) => {
			if (event.projectId !== activeProjectId) return;
			if (event.type === "backend") watcherReady = true;
			if (event.type === "changed") {
				queueRefresh();
				refreshActivity();
			}
			if (event.type === "indexed") {
				void listSessions(activeProjectId)
					.then((sessions) => {
						if (!disposed) replaceProjectSessions(activeProjectId, sessions);
					})
					.catch((error) =>
						console.error("Failed to load background-indexed sessions", error),
					);
			}
			if (event.type === "error") {
				watcherReady = false;
				console.warn("Session watcher fallback active", event.message);
			}
		})
			.then(async (unlisten) => {
				if (disposed) {
					unlisten();
					return;
				}
				unlistenSessionWatch = unlisten;
				await startSessionWatch(activeProjectId);
				if (disposed) {
					void stopSessionWatch(activeProjectId).catch(() => undefined);
					return;
				}
				watcherReady = true;
			})
			.catch((error) =>
				console.error("Failed to start session watcher", error),
			);
		return () => {
			disposed = true;
			if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
			if (initialRefreshTimer !== undefined)
				window.clearTimeout(initialRefreshTimer);
			if (initialRefreshIdleId !== undefined && idleWindow.cancelIdleCallback) {
				idleWindow.cancelIdleCallback(initialRefreshIdleId);
			}
			if (activityTimer !== undefined) window.clearTimeout(activityTimer);
			window.removeEventListener("focus", queueRefresh);
			unlistenRuntime?.();
			unlistenSessionWatch?.();
			void stopSessionWatch(activeProjectId).catch(() => undefined);
		};
	}, [
		activeProjectId,
		refreshExternalActivity,
		refreshProjectSessions,
		replaceProjectSessions,
	]);

	const activeExternalActivity = activeProjectId
		? externalActivity.get(activeProjectId)
		: undefined;
	const externalSessionPaths =
		activeExternalActivity?.sessionPaths ?? EMPTY_PATHS;
	const externalOpenTurnPaths =
		activeExternalActivity?.openTurnPaths ?? EMPTY_PATHS;

	const sidebarSessions = useMemo(
		() =>
			indexedSessions.map((session) => {
				const sidebar = toSidebarSession(session);
				return externalActivity
					.get(session.projectId)
					?.openTurnPaths.has(session.sessionPath)
					? { ...sidebar, active: true, externalActive: true }
					: sidebar;
			}),
		[indexedSessions, externalActivity],
	);

	const updateSession = useCallback(
		async (sessionId: string, update: SessionUiUpdate) => {
			const session = indexedSessions.find(
				(candidate) => candidate.piSessionId === sessionId,
			);
			if (!session) return null;
			try {
				const next = await updateSessionUiState(session.sessionPath, {
					pinned: session.pinned,
					titleOverride:
						update.title === undefined ? session.titleOverride : update.title,
				});
				setIndexedSessions((current) =>
					current.map((candidate) =>
						candidate.sessionPath === next.sessionPath ? next : candidate,
					),
				);
				return next;
			} catch (error) {
				console.error("Failed to update session UI state", error);
				return null;
			}
		},
		[indexedSessions],
	);

	const removeSession = useCallback(
		async (sessionId: string) => {
			const session = indexedSessions.find(
				(candidate) => candidate.piSessionId === sessionId,
			);
			if (!session) return null;
			const result = await deleteSession(
				session.projectId,
				session.sessionPath,
			);
			setIndexedSessions((current) =>
				current.filter(
					(candidate) => candidate.sessionPath !== session.sessionPath,
				),
			);
			return { session, result };
		},
		[indexedSessions],
	);

	return {
		indexedSessions,
		externalSessionPaths,
		externalOpenTurnPaths,
		refreshProjectSessions,
		refreshingProjectIds,
		sidebarSessions,
		updateSession,
		removeSession,
	};
}
