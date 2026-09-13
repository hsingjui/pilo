import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { ConversationEvent } from "@/lib/conversation-types";

export const SESSIONS_CHANGED_EVENT = "pilo:sessions-changed";

export type SessionIndexEntry = {
	connectionId: string;
	projectId: string;
	piSessionId: string;
	sessionPath: string;
	name: string | null;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	lastMessageAt: string | null;
	firstUserMessagePreview: string | null;
	fileSize: number;
	fileMtimeNs: number;
	lastOffset: number;
	indexedAtMs: number;
	pinned: boolean;
	archived: boolean;
	titleOverride: string | null;
};

export type SessionUiStateUpdate = {
	pinned: boolean;
	archived: boolean;
	titleOverride: string | null;
};

export type SessionReconcileResult = {
	sessions: SessionIndexEntry[];
	added: number;
	updated: number;
	removed: number;
	unchanged: number;
};

export type SessionHistory = {
	events: ConversationEvent[];
	model: { provider: string; id: string } | null;
	thinkingLevel: string | null;
	name: string | null;
	sourceMessageCount: number;
};

export type SessionWatchEvent =
	| { type: "changed"; projectId: string }
	| { type: "indexed"; projectId: string }
	| { type: "backend"; projectId: string; backend: string }
	| { type: "error"; projectId: string; message: string };

const reconcileInFlight = new Map<string, Promise<SessionReconcileResult>>();

export function listSessions(projectId: string): Promise<SessionIndexEntry[]> {
	return invoke<SessionIndexEntry[]>("session_list", { projectId });
}

export function loadSessionHistory(
	projectId: string,
	sessionPath: string,
): Promise<SessionHistory> {
	return invoke<SessionHistory>("session_history", {
		projectId,
		sessionPath,
	});
}

export function reconcileSessions(
	projectId: string,
): Promise<SessionReconcileResult> {
	const existing = reconcileInFlight.get(projectId);
	if (existing) return existing;

	const request = invoke<SessionReconcileResult>("session_reconcile", {
		projectId,
	}).finally(() => {
		if (reconcileInFlight.get(projectId) === request) {
			reconcileInFlight.delete(projectId);
		}
	});
	reconcileInFlight.set(projectId, request);
	return request;
}

export function startSessionWatch(projectId: string): Promise<void> {
	return invoke("session_watch_start", { projectId });
}

export function stopSessionWatch(projectId: string): Promise<void> {
	return invoke("session_watch_stop", { projectId });
}

export function listenSessionWatchEvents(
	handler: (event: SessionWatchEvent) => void,
): Promise<UnlistenFn> {
	return listen<SessionWatchEvent>("pilo://sessions", (event) =>
		handler(event.payload),
	);
}

export function updateSessionUiState(
	sessionPath: string,
	update: SessionUiStateUpdate,
): Promise<SessionIndexEntry> {
	return invoke<SessionIndexEntry>("session_update_ui_state", {
		sessionPath,
		update,
	});
}

export function notifySessionsChanged() {
	window.dispatchEvent(new Event(SESSIONS_CHANGED_EVENT));
}
