import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
	mergeProjectSessions,
	sameStringSet,
	toProjectExternalActivity,
	type ProjectExternalActivity,
} from "@/components/app/app-session-index-model";
import type { PiloClientBootstrap } from "@shared/api/pilo-client";
import type { Project } from "@/lib/api/projects";
import type {
	SessionExternalActivity,
	SessionIndexEntry,
} from "@/lib/api/sessions";
import { runtimeSessionPathKey } from "@shared/chat/chat-session-runtime-model";
import type { WebPiloClient } from "./web-pilo-client";

type UseRemoteSessionsOptions = {
	client: WebPiloClient | null;
	browserOnline: boolean;
	handleExpiredAuth: (error: unknown) => boolean;
	setFatalError: (message: string | null) => void;
	resyncKey: number;
	snapshotRefreshKey: number;
};

export function useRemoteSessions({
	client,
	browserOnline,
	handleExpiredAuth,
	setFatalError,
	resyncKey,
	snapshotRefreshKey,
}: UseRemoteSessionsOptions) {
	const [projects, setProjects] = useState<Project[]>([]);
	const [localPiResources, setLocalPiResources] = useState<
		Record<string, boolean>
	>({});
	const [bootstrapSettled, setBootstrapSettled] = useState(false);
	const [chatSessions, setChatSessions] = useState<
		PiloClientBootstrap["chatSessions"]
	>([]);
	const [rawSessions, setRawSessions] = useState<SessionIndexEntry[]>([]);
	const [refreshErrors, setRefreshErrors] = useState<
		ReadonlyMap<string, string>
	>(() => new Map());
	const refreshRequestsRef = useRef(
		new Map<string, { promise: Promise<void>; rerun: boolean }>(),
	);
	const sessionRevisionsRef = useRef(new Map<string, number>());
	const confirmedNamesRef = useRef(new Map<string, Map<string, string>>());
	const [externalActivity, setExternalActivity] = useState<
		ReadonlyMap<string, ProjectExternalActivity>
	>(() => new Map());
	const [refreshingProjectIds, setRefreshingProjectIds] = useState<
		ReadonlySet<string>
	>(() => new Set());
	// Activity-only bootstrap updates must not restart project scans or polling.
	const projectIdsKey = projects.map((project) => project.id).join("\0");
	const projectIds = useMemo(
		() => (projectIdsKey ? projectIdsKey.split("\0") : []),
		[projectIdsKey],
	);
	const runtimeActivityRefreshTimerRef = useRef<number | null>(null);
	const reloadBootstrapRef = useRef<(() => Promise<void>) | null>(null);
	const refreshProjectSessionsRef = useRef<
		((projectId: string) => Promise<void>) | null
	>(null);
	const runtimeActivityProjectIdsRef = useRef(new Set<string>());

	const reloadBootstrap = useCallback(async () => {
		if (!client) return;
		try {
			const bootstrap = await client.bootstrap();
			setProjects(bootstrap.projects);
			setLocalPiResources(bootstrap.localPiResources ?? {});
			setChatSessions(bootstrap.chatSessions);
			setFatalError(null);
		} catch (error) {
			if (!handleExpiredAuth(error)) {
				setFatalError(error instanceof Error ? error.message : String(error));
			}
		} finally {
			setBootstrapSettled(true);
		}
	}, [client, handleExpiredAuth, setFatalError]);

	const advanceSessionRevision = useCallback((projectId: string) => {
		const revision = (sessionRevisionsRef.current.get(projectId) ?? 0) + 1;
		sessionRevisionsRef.current.set(projectId, revision);
		return revision;
	}, []);

	const confirmSessionName = useCallback(
		(projectId: string, sessionPath: string, name: string) => {
			const pathKey = runtimeSessionPathKey(sessionPath);
			const names = confirmedNamesRef.current.get(projectId) ?? new Map();
			names.set(pathKey, name);
			confirmedNamesRef.current.set(projectId, names);
			setRawSessions((current) => {
				const index = current.findIndex(
					(session) =>
						session.projectId === projectId &&
						session.name === null &&
						runtimeSessionPathKey(session.sessionPath) === pathKey,
				);
				if (index < 0) return current;
				const next = current.slice();
				next[index] = { ...next[index], name };
				return next;
			});
		},
		[],
	);

	const mergeIndexedSessions = useCallback(
		(projectId: string, sessions: SessionIndexEntry[]) => {
			const names = confirmedNamesRef.current.get(projectId);
			// An older cached read cannot erase a name already confirmed by Pi.
			const next = names
				? sessions.map((session) => {
						const pathKey = runtimeSessionPathKey(session.sessionPath);
						if (session.name !== null) {
							names.delete(pathKey);
							return session;
						}
						const name = names.get(pathKey);
						return name ? { ...session, name } : session;
					})
				: sessions;
			if (names?.size === 0) confirmedNamesRef.current.delete(projectId);
			setRawSessions((current) =>
				mergeProjectSessions(current, projectId, next),
			);
		},
		[],
	);

	const removeIndexedSession = useCallback(
		(projectId: string, sessionPath: string) => {
			advanceSessionRevision(projectId);
			const names = confirmedNamesRef.current.get(projectId);
			names?.delete(runtimeSessionPathKey(sessionPath));
			if (names?.size === 0) confirmedNamesRef.current.delete(projectId);
			setRawSessions((current) =>
				current.filter(
					(session) =>
						session.projectId !== projectId ||
						session.sessionPath !== sessionPath,
				),
			);
		},
		[advanceSessionRevision],
	);

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
				const existing = refreshRequestsRef.current.get(projectId);
				if (existing) {
					existing.rerun = true;
					await existing.promise;
					return;
				}
				const request = { promise: Promise.resolve(), rerun: false };
				const refresh = async () => {
					// Like desktop, show the Host index before contacting the server.
					const cachedRevision = advanceSessionRevision(projectId);
					try {
						const cached = await client.listCachedSessions(projectId);
						if (sessionRevisionsRef.current.get(projectId) === cachedRevision) {
							mergeIndexedSessions(projectId, cached);
						}
					} catch (error) {
						if (handleExpiredAuth(error)) return;
						console.debug("Failed to load cached remote sessions", error);
					}
					do {
						request.rerun = false;
						const revision = advanceSessionRevision(projectId);
						try {
							/* oxlint-disable-next-line no-await-in-loop -- Queued scans must run serially. */
							const next = await client.listSessions(projectId);
							if (sessionRevisionsRef.current.get(projectId) === revision) {
								mergeIndexedSessions(projectId, next);
							}
						} catch (error) {
							if (handleExpiredAuth(error)) return;
							if (!request.rerun) throw error;
						}
					} while (request.rerun);
					setRefreshErrors((current) => {
						if (!current.has(projectId)) return current;
						const nextErrors = new Map(current);
						nextErrors.delete(projectId);
						return nextErrors;
					});
				};
				request.promise = refresh();
				refreshRequestsRef.current.set(projectId, request);
				try {
					await request.promise;
				} finally {
					refreshRequestsRef.current.delete(projectId);
				}
			} catch (error) {
				if (!handleExpiredAuth(error)) {
					setRefreshErrors((current) =>
						new Map(current).set(
							projectId,
							error instanceof Error ? error.message : String(error),
						),
					);
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
		[advanceSessionRevision, client, handleExpiredAuth, mergeIndexedSessions],
	);

	useEffect(() => {
		if (!client) return;
		let disposed = false;
		const revisions = new Map<string, number>();
		const unlisten = client.listenChatEvents((event) => {
			if (
				(event.type !== "sessions_indexed" &&
					event.type !== "session_index_error") ||
				!projectIds.includes(event.projectId)
			) {
				return;
			}
			const projectId = event.projectId;
			const revision = (revisions.get(projectId) ?? 0) + 1;
			revisions.set(projectId, revision);
			const isCurrent = () =>
				!disposed && revisions.get(projectId) === revision;
			const refresh = async () => {
				// Wait for all queued scans before reading the committed background batch.
				let pending = refreshRequestsRef.current.get(projectId);
				while (pending) {
					/* oxlint-disable-next-line no-await-in-loop -- Wait until newer queued scans have also settled. */
					await pending.promise.catch(() => undefined);
					if (!isCurrent()) return;
					pending = refreshRequestsRef.current.get(projectId);
				}
				if (!isCurrent()) return;
				if (event.type === "session_index_error") {
					setRefreshErrors((current) =>
						new Map(current).set(projectId, event.message),
					);
				}
				const sessionRevision = sessionRevisionsRef.current.get(projectId);
				const cached = await client.listCachedSessions(projectId);
				if (
					!isCurrent() ||
					sessionRevisionsRef.current.get(projectId) !== sessionRevision
				)
					return;
				mergeIndexedSessions(projectId, cached);
			};
			void refresh().catch((error) => {
				if (isCurrent() && !handleExpiredAuth(error)) {
					console.warn(
						"Failed to load background-indexed remote sessions",
						error,
					);
				}
			});
		});
		return () => {
			disposed = true;
			unlisten();
		};
	}, [client, handleExpiredAuth, mergeIndexedSessions, projectIds]);

	const refreshAllSessions = useCallback(async () => {
		if (!client) {
			setRawSessions([]);
			return;
		}
		setRawSessions((current) =>
			current.filter((session) => projectIds.includes(session.projectId)),
		);
		// A failed project refresh leaves its last successful snapshot intact.
		await Promise.all(
			projectIds.map((projectId) => refreshProjectSessions(projectId)),
		);
	}, [client, projectIds, refreshProjectSessions]);

	const applyExternalActivity = useCallback(
		(projectId: string, activities: readonly SessionExternalActivity[]) => {
			const nextActivity = toProjectExternalActivity(activities);
			setExternalActivity((current) => {
				const previous = current.get(projectId);
				if (
					previous &&
					sameStringSet(previous.openTurnPaths, nextActivity.openTurnPaths)
				) {
					return current;
				}
				if (!previous && nextActivity.openTurnPaths.size === 0) return current;
				const nextMap = new Map(current);
				if (nextActivity.openTurnPaths.size === 0) nextMap.delete(projectId);
				else nextMap.set(projectId, nextActivity);
				return nextMap;
			});
		},
		[],
	);

	const isExternalOpenTurn = useCallback(
		(projectId: string, sessionPath: string) =>
			externalActivity.get(projectId)?.openTurnPaths.has(sessionPath) ?? false,
		[externalActivity],
	);

	useEffect(() => {
		refreshProjectSessionsRef.current = refreshProjectSessions;
	}, [refreshProjectSessions]);

	// Debounced Host chat-session refresh so the sidebar running/unread markers
	// track every session, not just the visible one. ponytail: refetch bootstrap on
	// activity bursts; add a Host activity endpoint if this proves heavy.
	const scheduleRuntimeActivityRefresh = useCallback((projectId?: string) => {
		if (projectId) runtimeActivityProjectIdsRef.current.add(projectId);
		if (runtimeActivityRefreshTimerRef.current !== null) return;
		runtimeActivityRefreshTimerRef.current = window.setTimeout(() => {
			runtimeActivityRefreshTimerRef.current = null;
			void reloadBootstrapRef.current?.();
			for (const pendingProjectId of runtimeActivityProjectIdsRef.current) {
				void refreshProjectSessionsRef.current?.(pendingProjectId);
			}
			runtimeActivityProjectIdsRef.current.clear();
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

	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- Snapshot/replay generations intentionally retrigger authoritative Remote Host metadata synchronization. */
	useEffect(() => {
		void resyncKey;
		void snapshotRefreshKey;
		void reloadBootstrap();
	}, [reloadBootstrap, resyncKey, snapshotRefreshKey]);
	useEffect(() => {
		void resyncKey;
		void snapshotRefreshKey;
		void refreshAllSessions();
	}, [refreshAllSessions, resyncKey, snapshotRefreshKey]);

	// The Host pushes external Pi activity changes; snapshots resync on reconnect
	// and foreground, when pushed events may have been missed.
	useEffect(() => {
		void resyncKey;
		void snapshotRefreshKey;
		if (!client || projectIds.length === 0) {
			setExternalActivity(new Map());
			return;
		}
		let disposed = false;
		// A push received during this refresh takes priority over the pending snapshot.
		const pushedProjectIds = new Set<string>();
		const unlisten = client.listenChatEvents((event) => {
			if (
				event.type === "external_session_activity_changed" &&
				projectIds.includes(event.projectId)
			) {
				pushedProjectIds.add(event.projectId);
				applyExternalActivity(event.projectId, event.activities);
			}
		});
		if (browserOnline) {
			for (const projectId of projectIds) {
				void client
					.externalActivity(projectId)
					.then((activities) => {
						if (!disposed && !pushedProjectIds.has(projectId)) {
							applyExternalActivity(projectId, activities);
						}
					})
					.catch((error) => {
						if (!disposed && !handleExpiredAuth(error)) {
							console.debug("Failed to inspect external Pi activity", error);
						}
					});
			}
		}
		return () => {
			disposed = true;
			unlisten();
		};
	}, [
		applyExternalActivity,
		browserOnline,
		client,
		handleExpiredAuth,
		projectIds,
		resyncKey,
		snapshotRefreshKey,
	]);
	/* oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies */

	return {
		projects,
		localPiResources,
		bootstrapSettled,
		chatSessions,
		rawSessions,
		confirmSessionName,
		removeIndexedSession,
		externalActivity,
		isExternalOpenTurn,
		refreshingProjectIds,
		refreshError: refreshErrors.values().next().value ?? null,
		clearRefreshErrors: () => setRefreshErrors(new Map()),
		reloadBootstrap,
		refreshProjectSessions,
		refreshAllSessions,
		scheduleRuntimeActivityRefresh,
	};
}
