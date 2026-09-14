import { useCallback, useEffect, useMemo, useState } from "react";

import { toSidebarSession } from "@/components/app/app-chat-state";
import { listenRuntimeEvents } from "@/lib/pi-runtime";
import {
	deleteSession,
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
				const result = await reconcileSessions(projectId);
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
		let watcherReady = false;
		let unlistenRuntime: (() => void) | undefined;
		let unlistenSessionWatch: (() => void) | undefined;

		const refresh = () => {
			void refreshProjectSessions(activeProjectId).catch((error) =>
				console.error("Failed to reconcile sessions", error),
			);
		};
		const queueRefresh = () => {
			if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
			refreshTimer = window.setTimeout(refresh, 120);
		};
		const hydrateThenRefresh = async () => {
			try {
				const cached = await listSessions(activeProjectId);
				if (!disposed) replaceProjectSessions(activeProjectId, cached);
			} catch (error) {
				console.error("Failed to load cached sessions", error);
			}
			if (!disposed) refresh();
		};

		void hydrateThenRefresh();
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
			if (event.type === "changed") queueRefresh();
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
			window.removeEventListener("focus", queueRefresh);
			unlistenRuntime?.();
			unlistenSessionWatch?.();
			void stopSessionWatch(activeProjectId).catch(() => undefined);
		};
	}, [activeProjectId, refreshProjectSessions, replaceProjectSessions]);

	const sidebarSessions = useMemo(
		() => indexedSessions.map(toSidebarSession),
		[indexedSessions],
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
		refreshProjectSessions,
		refreshingProjectIds,
		sidebarSessions,
		updateSession,
		removeSession,
	};
}
