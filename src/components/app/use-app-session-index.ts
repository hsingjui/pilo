import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toSidebarSession } from "@/components/app/app-chat-state";
import {
	mergeProjectSessions,
	runtimeActivityFromStates,
	sameRuntimeActivity,
	sameStringSet,
	toProjectExternalActivity,
	type ProjectExternalActivity,
	type ProjectRuntimeActivity,
} from "@/components/app/app-session-index-model";
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
	type SessionIndexEntry,
} from "@/lib/sessions";

type SessionUiUpdate = {
	title?: string;
};

const EXTERNAL_ACTIVITY_FALLBACK_POLL_MS = 15_000;

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
	const projectGenerationsRef = useRef(new Map<string, number>());
	const externalActivityRequestsRef = useRef(
		new Map<string, { generation: number; promise: Promise<void> }>(),
	);
	const projectRefreshRequestsRef = useRef(
		new Map<
			string,
			{ generation: number; promise: Promise<void>; rerun: boolean }
		>(),
	);
	const runtimeActivityRefreshRef = useRef<{
		promise: Promise<void> | null;
		rerun: boolean;
	}>({ promise: null, rerun: false });
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

	const advanceProjectGeneration = useCallback((projectId: string) => {
		const nextGeneration =
			(projectGenerationsRef.current.get(projectId) ?? 0) + 1;
		projectGenerationsRef.current.set(projectId, nextGeneration);
		return nextGeneration;
	}, []);

	const isCurrentProjectGeneration = useCallback(
		(projectId: string, generation: number) =>
			watchedProjectIdsRef.current.has(projectId) &&
			projectGenerationsRef.current.get(projectId) === generation,
		[],
	);

	const refreshExternalActivity = useCallback(
		(projectId: string) => {
			const generation = projectGenerationsRef.current.get(projectId);
			if (
				generation === undefined ||
				!watchedProjectIdsRef.current.has(projectId)
			) {
				return Promise.resolve();
			}
			const existing = externalActivityRequestsRef.current.get(projectId);
			if (existing?.generation === generation) return existing.promise;

			let tracked: Promise<void>;
			tracked = getExternalSessionActivity(projectId)
				.then((activities) => {
					if (!isCurrentProjectGeneration(projectId, generation)) return;
					const nextActivity = toProjectExternalActivity(activities);
					setExternalActivity((current) => {
						const previous = current.get(projectId);
						if (
							previous &&
							sameStringSet(previous.openTurnPaths, nextActivity.openTurnPaths)
						) {
							return current;
						}
						if (nextActivity.openTurnPaths.size === 0) {
							if (!previous) return current;
							const nextMap = new Map(current);
							nextMap.delete(projectId);
							return nextMap;
						}
						const nextMap = new Map(current);
						nextMap.set(projectId, nextActivity);
						return nextMap;
					});
				})
				.catch((error) => {
					if (isCurrentProjectGeneration(projectId, generation)) {
						setExternalActivity((current) => {
							if (!current.has(projectId)) return current;
							const nextMap = new Map(current);
							nextMap.delete(projectId);
							return nextMap;
						});
					}
					console.debug("Failed to inspect external Pi activity", error);
				})
				.finally(() => {
					if (
						externalActivityRequestsRef.current.get(projectId)?.promise ===
						tracked
					) {
						externalActivityRequestsRef.current.delete(projectId);
					}
				});
			externalActivityRequestsRef.current.set(projectId, {
				generation,
				promise: tracked,
			});
			return tracked;
		},
		[isCurrentProjectGeneration],
	);

	const refreshRuntimeActivity = useCallback(() => {
		const refresh = runtimeActivityRefreshRef.current;
		if (refresh.promise) {
			refresh.rerun = true;
			return refresh.promise;
		}

		const run = async (): Promise<void> => {
			refresh.rerun = false;
			try {
				const states = await listChatSessionRuntimeStates();
				const nextActivity = runtimeActivityFromStates(
					states,
					watchedProjectIdsRef.current,
				);
				setRuntimeActivity((current) =>
					sameRuntimeActivity(current, nextActivity) ? current : nextActivity,
				);
			} catch (error) {
				console.debug("Failed to inspect Pilo runtime activity", error);
			}
			if (refresh.rerun) await run();
		};
		let tracked: Promise<void>;
		tracked = run().finally(() => {
			if (refresh.promise === tracked) refresh.promise = null;
		});
		refresh.promise = tracked;
		return tracked;
	}, []);

	/* oxlint-disable react/memo-dependencies -- The callbacks below are stable, but keeping them in exhaustive-deps makes the async refresh closure explicit and stale-safe. */
	const refreshProjectSessions = useCallback(
		async (projectId: string, showProgress = false) => {
			const generation = projectGenerationsRef.current.get(projectId);
			if (
				generation === undefined ||
				!watchedProjectIdsRef.current.has(projectId)
			) {
				return;
			}
			if (showProgress) {
				setRefreshingProjectIds((current) => {
					if (current.has(projectId)) return current;
					const nextSet = new Set(current);
					nextSet.add(projectId);
					return nextSet;
				});
			}
			try {
				const existing = projectRefreshRequestsRef.current.get(projectId);
				if (existing?.generation === generation) {
					existing.rerun = true;
					await existing.promise;
					return;
				}

				const refreshState = {
					generation,
					promise: Promise.resolve(),
					rerun: false,
				};
				const run = async (): Promise<void> => {
					refreshState.rerun = false;
					const [result] = await Promise.all([
						reconcileSessions(projectId),
						refreshExternalActivity(projectId),
					]);
					if (!isCurrentProjectGeneration(projectId, generation)) return;
					setIndexedSessions((current) =>
						mergeProjectSessions(current, projectId, result.sessions),
					);
					if (refreshState.rerun) await run();
				};
				let tracked: Promise<void>;
				tracked = run().finally(() => {
					if (
						projectRefreshRequestsRef.current.get(projectId) === refreshState
					) {
						projectRefreshRequestsRef.current.delete(projectId);
					}
				});
				refreshState.promise = tracked;
				projectRefreshRequestsRef.current.set(projectId, refreshState);
				await tracked;
			} finally {
				if (showProgress) {
					setRefreshingProjectIds((current) => {
						if (!current.has(projectId)) return current;
						const nextSet = new Set(current);
						nextSet.delete(projectId);
						return nextSet;
					});
				}
			}
		},
		[isCurrentProjectGeneration, refreshExternalActivity],
	);
	/* oxlint-enable react/memo-dependencies */

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
		const addedGenerations = new Map(
			added.map((projectId) => [
				projectId,
				advanceProjectGeneration(projectId),
			]),
		);
		for (const projectId of removed) advanceProjectGeneration(projectId);

		if (removed.length > 0) {
			const removedProjectIds = new Set(removed);
			setIndexedSessions((current) =>
				current.filter((session) => !removedProjectIds.has(session.projectId)),
			);
			setExternalActivity((current) => {
				let changed = false;
				const nextMap = new Map(current);
				for (const projectId of removedProjectIds) {
					changed = nextMap.delete(projectId) || changed;
				}
				return changed ? nextMap : current;
			});
			setRuntimeActivity((current) => {
				let changed = false;
				const nextMap = new Map(current);
				for (const projectId of removedProjectIds) {
					changed = nextMap.delete(projectId) || changed;
				}
				return changed ? nextMap : current;
			});
			setRefreshingProjectIds((current) => {
				const nextSet = new Set(
					[...current].filter((projectId) => !removedProjectIds.has(projectId)),
				);
				return nextSet.size === current.size ? current : nextSet;
			});
		}

		for (const projectId of removed) {
			void stopSessionWatch(projectId).catch(() => undefined);
		}
		for (const projectId of added) {
			const generation = addedGenerations.get(projectId)!;
			void listSessions(projectId)
				.then((sessions) => {
					if (isCurrentProjectGeneration(projectId, generation)) {
						replaceProjectSessions(projectId, sessions);
					}
				})
				.catch((error) =>
					console.error("Failed to load cached sessions", error),
				);
			void refreshExternalActivity(projectId);
			void startSessionWatch(projectId)
				.then(() => {
					if (!isCurrentProjectGeneration(projectId, generation)) {
						if (!watchedProjectIdsRef.current.has(projectId)) {
							void stopSessionWatch(projectId).catch(() => undefined);
						}
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
		advanceProjectGeneration,
		isCurrentProjectGeneration,
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
			const generation = projectGenerationsRef.current.get(event.projectId);
			if (
				generation === undefined ||
				!isCurrentProjectGeneration(event.projectId, generation)
			) {
				return;
			}
			if (event.type === "changed") {
				void refreshProjectSessions(event.projectId).catch((error) =>
					console.error("Failed to reconcile changed sessions", error),
				);
			}
			if (event.type === "indexed") {
				void listSessions(event.projectId)
					.then((sessions) => {
						if (!isCurrentProjectGeneration(event.projectId, generation))
							return;
						replaceProjectSessions(event.projectId, sessions);
					})
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
		isCurrentProjectGeneration,
		refreshExternalActivity,
		refreshProjectSessions,
		refreshRuntimeActivity,
		replaceProjectSessions,
	]);

	useEffect(() => {
		const poll = () => {
			if (document.visibilityState !== "visible") return;
			for (const projectId of watchedProjectIdsRef.current) {
				void refreshExternalActivity(projectId);
			}
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible") poll();
		};
		const timer = window.setInterval(poll, EXTERNAL_ACTIVITY_FALLBACK_POLL_MS);
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
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
