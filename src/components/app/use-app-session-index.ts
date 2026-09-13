import { useCallback, useEffect, useMemo, useState } from "react";

import { toSidebarSession } from "@/components/app/app-chat-state";
import { listenRuntimeEvents } from "@/lib/pi-runtime";
import {
	listSessions,
	listenSessionWatchEvents,
	reconcileSessions,
	startSessionWatch,
	stopSessionWatch,
	updateSessionUiState,
	type SessionIndexEntry,
} from "@/lib/sessions";

type SessionUiUpdate = {
	pinned?: boolean;
	archived?: boolean;
	title?: string;
};

export function useAppSessionIndex(activeProjectId: string | null) {
	const [indexedSessions, setIndexedSessions] = useState<SessionIndexEntry[]>(
		[],
	);

	const replaceProjectSessions = useCallback(
		(projectId: string, sessions: SessionIndexEntry[]) => {
			setIndexedSessions((current) => [
				...current.filter((session) => session.projectId !== projectId),
				...sessions,
			]);
		},
		[],
	);

	const refreshProjectSessions = useCallback(
		async (projectId: string) => {
			const result = await reconcileSessions(projectId);
			replaceProjectSessions(projectId, result.sessions);
		},
		[replaceProjectSessions],
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
					pinned: update.pinned ?? session.pinned,
					archived: update.archived ?? session.archived,
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

	return {
		indexedSessions,
		refreshProjectSessions,
		sidebarSessions,
		updateSession,
	};
}
