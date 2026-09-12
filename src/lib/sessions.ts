import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { ConversationEvent } from "@/lib/conversation-types";

export const SESSIONS_CHANGED_EVENT = "pilo:sessions-changed";

export type SessionIndexEntry = {
	connectionId: string;
	workspaceId: string;
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
	| { type: "changed"; workspaceId: string }
	| { type: "backend"; workspaceId: string; backend: string }
	| { type: "error"; workspaceId: string; message: string };

const reconcileInFlight = new Map<string, Promise<SessionReconcileResult>>();

export function listSessions(
	workspaceId: string,
): Promise<SessionIndexEntry[]> {
	return invoke<SessionIndexEntry[]>("session_list", { workspaceId });
}

export function loadSessionHistory(
	workspaceId: string,
	sessionPath: string,
): Promise<SessionHistory> {
	return invoke<SessionHistory>("session_history", {
		workspaceId,
		sessionPath,
	});
}

export function reconcileSessions(
	workspaceId: string,
): Promise<SessionReconcileResult> {
	const existing = reconcileInFlight.get(workspaceId);
	if (existing) return existing;

	const request = invoke<SessionReconcileResult>("session_reconcile", {
		workspaceId,
	}).finally(() => {
		if (reconcileInFlight.get(workspaceId) === request) {
			reconcileInFlight.delete(workspaceId);
		}
	});
	reconcileInFlight.set(workspaceId, request);
	return request;
}

export function startSessionWatch(workspaceId: string): Promise<void> {
	return invoke("session_watch_start", { workspaceId });
}

export function stopSessionWatch(workspaceId: string): Promise<void> {
	return invoke("session_watch_stop", { workspaceId });
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
