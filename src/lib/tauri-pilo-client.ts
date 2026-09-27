import { invoke } from "@tauri-apps/api/core";

import {
	listChatSessionRuntimeStates,
	type ChatSessionRuntimeState,
} from "@/lib/chat-session-client";
import { listenRuntimeEvents, type PiSessionSnapshot } from "@/lib/pi-runtime";
import {
	type PiloClient,
	type PiloClientBootstrap,
	type PiloClientEventOptions,
	type PiloClientHistoryOptions,
	type PiloClientStartChatInput,
} from "@/lib/pilo-client";
import { listProjects } from "@/lib/projects";
import {
	getCachedProjectPiModels,
	hydrateProjectPiModels,
	type ProjectPiModels,
} from "@/lib/pi-models";
import {
	deleteSession as invokeDeleteSession,
	loadSessionHistoryWindow,
	readSessionHistoryImage,
	reconcileSessions,
	requestSessionTitle,
	searchSessions as invokeSearchSessions,
	type SessionDeleteResult,
	type SessionHistoryFingerprint,
	type SessionHistoryResult,
	type SessionIndexEntry,
	type SessionSearchMatch,
} from "@/lib/sessions";

export class TauriPiloClient implements PiloClient {
	private sequence = 0;

	async bootstrap(): Promise<PiloClientBootstrap> {
		const [projects, chatSessions] = await Promise.all([
			listProjects(),
			listChatSessionRuntimeStates(),
		]);
		return {
			projects,
			chatSessions,
			latestSequence: this.sequence,
		};
	}

	async listSessions(projectId: string): Promise<SessionIndexEntry[]> {
		const result = await reconcileSessions(projectId);
		return result.sessions;
	}

	searchSessions(
		projectId: string,
		query: string,
		limit?: number,
	): Promise<SessionSearchMatch[]> {
		return invokeSearchSessions(projectId, query, limit);
	}

	loadHistory(
		projectId: string,
		sessionPath: string,
		options?: PiloClientHistoryOptions,
	): Promise<SessionHistoryResult> {
		return loadSessionHistoryWindow(projectId, sessionPath, {
			startMessage: options?.startMessage,
			messageLimit: options?.messageLimit ?? 256,
			includeMessageIndex: options?.includeMessageIndex ?? true,
			fingerprint: options?.fingerprint,
		});
	}

	readHistoryImage(
		projectId: string,
		sessionPath: string,
		imageId: string,
		fingerprint?: SessionHistoryFingerprint,
	): Promise<Uint8Array<ArrayBuffer>> {
		return readSessionHistoryImage(
			projectId,
			sessionPath,
			imageId,
			fingerprint,
		);
	}

	generateSessionTitle(
		projectId: string,
		message: string,
	): Promise<string | null> {
		return requestSessionTitle(projectId, message);
	}

	deleteSession(
		projectId: string,
		sessionPath: string,
	): Promise<SessionDeleteResult> {
		return invokeDeleteSession(projectId, sessionPath);
	}

	async loadModels(projectId: string): Promise<ProjectPiModels | null> {
		await hydrateProjectPiModels();
		return getCachedProjectPiModels(projectId);
	}

	startChat(input: PiloClientStartChatInput): Promise<PiSessionSnapshot> {
		return invoke<PiSessionSnapshot>("chat_session_start", input);
	}

	stopChat(sessionKey: string, reason?: string): Promise<void> {
		return invoke<void>("chat_session_stop", { sessionKey, reason });
	}

	chatState(sessionKey: string): Promise<ChatSessionRuntimeState | null> {
		return invoke<ChatSessionRuntimeState | null>("chat_session_state", {
			sessionKey,
		});
	}

	sendChatCommand(
		sessionKey: string,
		command: Record<string, unknown>,
	): Promise<void> {
		return invoke<void>("chat_session_send_rpc", { sessionKey, command });
	}

	async connectEvents(options: PiloClientEventOptions): Promise<() => void> {
		const unlisten = await listenRuntimeEvents((event) => {
			this.sequence += 1;
			options.onMessage({
				type: "events",
				events: [{ ...event, sequence: this.sequence }],
			});
		});
		options.onStatus(true);
		return () => {
			unlisten();
			options.onStatus(false);
		};
	}
}

export const tauriPiloClient: PiloClient = new TauriPiloClient();
