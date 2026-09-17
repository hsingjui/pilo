import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { ConversationEvent } from "@/lib/conversation-types";
import type { PiModel } from "@/lib/pi-runtime";

export const SESSIONS_CHANGED_EVENT = "pilo:sessions-changed";

export type ConnectionNamingModel = {
	connectionId: string;
	provider: string;
	modelId: string;
};

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
	fileMtimeNs: string;
	lastOffset: number;
	indexedAtMs: number;
	pinned: boolean;
	titleOverride: string | null;
};

export type SessionUiStateUpdate = {
	pinned: boolean;
	titleOverride: string | null;
};

export type SessionReconcileResult = {
	sessions: SessionIndexEntry[];
	added: number;
	updated: number;
	removed: number;
	unchanged: number;
};

export type SessionExternalActivity = {
	path: string;
	turnOpen: boolean;
};

export type SessionSearchMatch = {
	sessionPath: string;
	sessionId: string;
	role: "user" | "assistant";
	snippet: string;
	timestamp: string | number | null;
};

export type SessionHistoryMessageIndexEntry = {
	id: string;
	role: "user" | "assistant" | "compaction";
	timestampMs?: number;
	preview: string;
	estimatedChars: number;
};

export type SessionHistory = {
	events: ConversationEvent[];
	model: { provider: string; id: string } | null;
	thinkingLevel: string | null;
	name: string | null;
	sourceMessageCount: number;
	windowStartMessage?: number;
	windowMessageCount?: number;
	totalMessages?: number;
	messageIndex?: SessionHistoryMessageIndexEntry[];
	stats?: {
		userMessages: number;
		assistantMessages: number;
		toolCalls: number;
		toolResults: number;
		totalMessages: number;
		tokens: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		cost: number;
		contextTokens: number | null;
	};
};

export type SessionHistoryFingerprint = {
	fileSize: number;
	fileMtimeNs: string;
};

export type SessionDeleteResult = {
	method: "trash" | "unlink";
};

export type SessionHistoryResult = {
	history: SessionHistory;
	fingerprint: SessionHistoryFingerprint | null;
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

export function listConnectionNamingModels(): Promise<ConnectionNamingModel[]> {
	return invoke<ConnectionNamingModel[]>("connection_naming_model_list");
}

export function setConnectionNamingModel(
	connectionId: string,
	model: Pick<PiModel, "provider" | "id"> | null,
): Promise<ConnectionNamingModel | null> {
	return invoke<ConnectionNamingModel | null>("connection_naming_model_set", {
		connectionId,
		provider: model ? model.provider : null,
		modelId: model ? model.id : null,
	});
}

export function requestSessionTitle(
	projectId: string,
	message: string,
): Promise<string | null> {
	return invoke<string | null>("session_generate_title", {
		projectId,
		message,
	});
}

const sessionHistoryDecoder = new TextDecoder();
const sessionHistoryInFlight = new Map<string, Promise<SessionHistoryResult>>();

function normalizeSessionHistoryResponse(
	value: SessionHistory | SessionHistoryResult,
): SessionHistoryResult {
	if ("history" in value) return value;
	return { history: value, fingerprint: null };
}

function decodeSessionHistoryResponse(
	response:
		| ArrayBuffer
		| Uint8Array
		| number[]
		| SessionHistory
		| SessionHistoryResult,
): SessionHistoryResult {
	if (response instanceof ArrayBuffer) {
		return normalizeSessionHistoryResponse(
			JSON.parse(sessionHistoryDecoder.decode(new Uint8Array(response))) as
				| SessionHistory
				| SessionHistoryResult,
		);
	}
	if (response instanceof Uint8Array) {
		return normalizeSessionHistoryResponse(
			JSON.parse(sessionHistoryDecoder.decode(response)) as
				| SessionHistory
				| SessionHistoryResult,
		);
	}
	if (Array.isArray(response)) {
		return normalizeSessionHistoryResponse(
			JSON.parse(sessionHistoryDecoder.decode(Uint8Array.from(response))) as
				| SessionHistory
				| SessionHistoryResult,
		);
	}
	return normalizeSessionHistoryResponse(response);
}

export function loadSessionHistory(
	projectId: string,
	sessionPath: string,
	fingerprint?: { fileSize: number; fileMtimeNs: string },
): Promise<SessionHistoryResult> {
	const requestKey = `${projectId}\0${sessionPath}\0${fingerprint?.fileSize ?? "?"}\0${fingerprint?.fileMtimeNs ?? "?"}`;
	const existing = sessionHistoryInFlight.get(requestKey);
	if (existing) return existing;

	const request = invoke<
		ArrayBuffer | Uint8Array | number[] | SessionHistory | SessionHistoryResult
	>("session_history", {
		projectId,
		sessionPath,
		expectedFileSize: fingerprint?.fileSize,
		expectedFileMtimeNs: fingerprint?.fileMtimeNs,
	})
		.then(decodeSessionHistoryResponse)
		.finally(() => {
			if (sessionHistoryInFlight.get(requestKey) === request) {
				sessionHistoryInFlight.delete(requestKey);
			}
		});
	sessionHistoryInFlight.set(requestKey, request);
	return request;
}

export function loadSessionHistoryWindow(
	projectId: string,
	sessionPath: string,
	options: {
		startMessage?: number;
		messageLimit: number;
		includeMessageIndex?: boolean;
		fingerprint?: { fileSize: number; fileMtimeNs: string };
	},
): Promise<SessionHistoryResult> {
	const requestKey = `${projectId}\0${sessionPath}\0window:${options.startMessage ?? "tail"}:${options.messageLimit}:${options.includeMessageIndex ? 1 : 0}\0${options.fingerprint?.fileSize ?? "?"}\0${options.fingerprint?.fileMtimeNs ?? "?"}`;
	const existing = sessionHistoryInFlight.get(requestKey);
	if (existing) return existing;

	const request = invoke<
		ArrayBuffer | Uint8Array | number[] | SessionHistory | SessionHistoryResult
	>("session_history", {
		projectId,
		sessionPath,
		expectedFileSize: options.fingerprint?.fileSize,
		expectedFileMtimeNs: options.fingerprint?.fileMtimeNs,
		startMessage: options.startMessage,
		messageLimit: options.messageLimit,
		includeMessageIndex: options.includeMessageIndex ?? false,
	})
		.then(decodeSessionHistoryResponse)
		.finally(() => {
			if (sessionHistoryInFlight.get(requestKey) === request) {
				sessionHistoryInFlight.delete(requestKey);
			}
		});
	sessionHistoryInFlight.set(requestKey, request);
	return request;
}

export function getExternalSessionActivity(
	projectId: string,
): Promise<SessionExternalActivity[]> {
	return invoke<SessionExternalActivity[]>("session_external_activity", {
		projectId,
	});
}

export function searchSessions(
	projectId: string,
	query: string,
	limit = 24,
): Promise<SessionSearchMatch[]> {
	return invoke<SessionSearchMatch[]>("session_search", {
		projectId,
		query,
		limit,
	});
}

export function deleteSession(
	projectId: string,
	sessionPath: string,
): Promise<SessionDeleteResult> {
	return invoke<SessionDeleteResult>("session_delete", {
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
