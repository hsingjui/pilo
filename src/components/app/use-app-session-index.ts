import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type Dispatch,
	type SetStateAction,
} from "react";

import { toSidebarSession } from "@/components/app/app-chat-state";
import { listChatSessionRuntimeStates } from "@/lib/chat-session-client";
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
	openTurnPaths: ReadonlySet<string>;
};

type ProjectRuntimeActivity = ReadonlyMap<string, ReadonlySet<string>>;

function sameRuntimeActivity(
	left: ProjectRuntimeActivity,
	right: ProjectRuntimeActivity,
) {
	if (left.size !== right.size) return false;
	for (const [projectId, paths] of left) {
		const nextPaths = right.get(projectId);
		if (!nextPaths || nextPaths.size !== paths.size) return false;
		for (const path of paths) {
			if (!nextPaths.has(path)) return false;
		}
	}
	return true;
}

function runtimeActivityFromStates(
	states: Awaited<ReturnType<typeof listChatSessionRuntimeStates>>,
): ProjectRuntimeActivity {
	const mutable = new Map<string, Set<string>>();
	for (const state of states) {
		if (
			!state.activeTurn ||
			state.snapshot.state !== "running" ||
			!state.sessionPath
		) {
			continue;
		}
		let paths = mutable.get(state.projectId);
		if (!paths) {
			paths = new Set();
			mutable.set(state.projectId, paths);
		}
		paths.add(state.sessionPath);
	}
	return mutable;
}

function toProjectExternalActivity(
	activities: readonly SessionExternalActivity[],
): ProjectExternalActivity {
	return {
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
		// 请求失败时清空该项目的活动状态，避免残留的 open-turn 让会话永远显示运行中。
		setExternalActivity((current) => {
			if (!current.has(projectId)) return current;
			const next = new Map(current);
			next.delete(projectId);
			return next;
		});
		console.debug("Failed to inspect external Pi activity", error);
	}
}

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

export function useAppSessionIndex(projectIds: readonly string[]) {
	const [indexedSessions, setIndexedSessions] = useState<SessionIndexEntry[]>(
		[],
	);
	const [externalActivity, setExternalActivity] = useState<
		ReadonlyMap<string, ProjectExternalActivity>
	>(() => new Map());
	const [runtimeActivity, setRuntimeActivity] =
		useState<ProjectRuntimeActivity>(() => new Map());
	const [refreshingProjectIds, setRefreshingProjectIds] = useState<
		ReadonlySet<string>
	>(() => new Set());
	const watchedProjectIdsRef = useRef(new Set<string>());
	const projectIdsKey = useMemo(
		() => [...new Set(projectIds)].join("\0"),
		[projectIds],
	);
	const stableProjectIds = useMemo(
		() => (projectIdsKey ? projectIdsKey.split("\0") : []),
		[projectIdsKey],
	);

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

	const refreshRuntimeActivity = useCallback(async () => {
		try {
			const states = await listChatSessionRuntimeStates();
			const next = runtimeActivityFromStates(states);
			setRuntimeActivity((current) =>
				sameRuntimeActivity(current, next) ? current : next,
			);
		} catch (error) {
			console.debug("Failed to inspect Pilo runtime activity", error);
		}
	}, []);

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
		const nextProjectIds = new Set(stableProjectIds);
		const previousProjectIds = watchedProjectIdsRef.current;
		const added = stableProjectIds.filter(
			(projectId) => !previousProjectIds.has(projectId),
		);
		const removed = [...previousProjectIds].filter(
			(projectId) => !nextProjectIds.has(projectId),
		);
		watchedProjectIdsRef.current = nextProjectIds;

		if (removed.length > 0) {
			const removedProjectIds = new Set(removed);
			setIndexedSessions((current) =>
				current.filter((session) => !removedProjectIds.has(session.projectId)),
			);
			setExternalActivity((current) => {
				let changed = false;
				const next = new Map(current);
				for (const projectId of removedProjectIds) {
					changed = next.delete(projectId) || changed;
				}
				return changed ? next : current;
			});
		}

		for (const projectId of removed) {
			void stopSessionWatch(projectId).catch(() => undefined);
		}
		for (const projectId of added) {
			void listSessions(projectId)
				.then((sessions) => {
					if (watchedProjectIdsRef.current.has(projectId)) {
						replaceProjectSessions(projectId, sessions);
					}
				})
				.catch((error) =>
					console.error("Failed to load cached sessions", error),
				);
			void refreshExternalActivity(projectId);
			void startSessionWatch(projectId)
				.then(() => {
					if (!watchedProjectIdsRef.current.has(projectId)) {
						void stopSessionWatch(projectId).catch(() => undefined);
						return;
					}
					void refreshProjectSessions(projectId).catch((error) =>
						console.error("Failed to reconcile sessions", error),
					);
				})
				.catch((error) =>
					console.error("Failed to start session watcher", error),
				);
		}
	}, [
		refreshExternalActivity,
		refreshProjectSessions,
		replaceProjectSessions,
		stableProjectIds,
	]);

	useEffect(() => {
		let disposed = false;
		let runtimeRefreshTimer: number | undefined;
		let unlistenRuntime: (() => void) | undefined;
		let unlistenSessionWatch: (() => void) | undefined;

		const queueRuntimeActivityRefresh = () => {
			if (runtimeRefreshTimer !== undefined) {
				window.clearTimeout(runtimeRefreshTimer);
			}
			runtimeRefreshTimer = window.setTimeout(() => {
				runtimeRefreshTimer = undefined;
				void refreshRuntimeActivity();
			}, 40);
		};
		const refreshKnownProjects = () => {
			queueRuntimeActivityRefresh();
			for (const projectId of watchedProjectIdsRef.current) {
				void refreshExternalActivity(projectId);
			}
		};

		queueRuntimeActivityRefresh();
		window.addEventListener("focus", refreshKnownProjects);
		void listenRuntimeEvents((event) => {
			switch (event.type) {
				case "user_message_start":
				case "assistant_message_start":
				case "assistant_message_end":
				case "runtime_error":
					queueRuntimeActivityRefresh();
					break;
				case "process_state":
					if (event.state === "stopped" || event.state === "failed") {
						queueRuntimeActivityRefresh();
					}
					break;
				default:
					break;
			}
			if (
				event.type === "assistant_message_end" &&
				event.projectId &&
				watchedProjectIdsRef.current.has(event.projectId)
			) {
				void refreshProjectSessions(event.projectId).catch((error) =>
					console.error("Failed to refresh completed session", error),
				);
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
			if (!watchedProjectIdsRef.current.has(event.projectId)) return;
			if (event.type === "changed") {
				void refreshProjectSessions(event.projectId).catch((error) =>
					console.error("Failed to reconcile changed sessions", error),
				);
				void refreshExternalActivity(event.projectId);
			}
			if (event.type === "indexed") {
				void listSessions(event.projectId)
					.then((sessions) => replaceProjectSessions(event.projectId, sessions))
					.catch((error) =>
						console.error("Failed to load background-indexed sessions", error),
					);
			}
			if (event.type === "error") {
				console.warn("Session watcher fallback active", event.message);
			}
		})
			.then((unlisten) => {
				if (disposed) unlisten();
				else unlistenSessionWatch = unlisten;
			})
			.catch((error) =>
				console.error("Failed to listen for session watcher events", error),
			);

		return () => {
			disposed = true;
			if (runtimeRefreshTimer !== undefined) {
				window.clearTimeout(runtimeRefreshTimer);
			}
			window.removeEventListener("focus", refreshKnownProjects);
			unlistenRuntime?.();
			unlistenSessionWatch?.();
		};
	}, [
		refreshExternalActivity,
		refreshProjectSessions,
		refreshRuntimeActivity,
		replaceProjectSessions,
	]);

	useEffect(() => {
		const poll = () => {
			for (const projectId of watchedProjectIdsRef.current) {
				void refreshExternalActivity(projectId);
			}
		};
		const timer = window.setInterval(poll, 5000);
		return () => window.clearInterval(timer);
	}, [refreshExternalActivity]);

	useEffect(
		() => () => {
			const watchedProjectIds = [...watchedProjectIdsRef.current];
			watchedProjectIdsRef.current.clear();
			for (const projectId of watchedProjectIds) {
				void stopSessionWatch(projectId).catch(() => undefined);
			}
		},
		[],
	);

	const isExternalOpenTurn = useCallback(
		(projectId: string, sessionPath: string) =>
			externalActivity.get(projectId)?.openTurnPaths.has(sessionPath) ?? false,
		[externalActivity],
	);

	const sidebarSessions = useMemo(
		() =>
			indexedSessions.map((session) => {
				const sidebar = toSidebarSession(session);
				const externalActive =
					externalActivity
						.get(session.projectId)
						?.openTurnPaths.has(session.sessionPath) ?? false;
				const runtimeActive =
					runtimeActivity.get(session.projectId)?.has(session.sessionPath) ??
					false;
				if (!externalActive && !runtimeActive) return sidebar;
				return {
					...sidebar,
					active: true,
				};
			}),
		[indexedSessions, externalActivity, runtimeActivity],
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
		isExternalOpenTurn,
		refreshProjectSessions,
		refreshingProjectIds,
		sidebarSessions,
		updateSession,
		removeSession,
	};
}
