import { invoke } from "@tauri-apps/api/core";

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

export function listSessions(
	workspaceId: string,
): Promise<SessionIndexEntry[]> {
	return invoke<SessionIndexEntry[]>("session_list", { workspaceId });
}

export function reconcileSessions(
	workspaceId: string,
): Promise<SessionReconcileResult> {
	return invoke<SessionReconcileResult>("session_reconcile", { workspaceId });
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
