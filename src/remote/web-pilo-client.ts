import type {
	PiloClient,
	PiloClientBootstrap,
	PiloClientEventOptions,
	PiloClientHistoryOptions,
	PiloClientStartChatInput,
} from "@/lib/pilo-client";
import type { PiSessionSnapshot } from "@/lib/pi-runtime";
import type { ProjectPiModels } from "@/lib/pi-models";
import type {
	SessionDeleteResult,
	SessionExternalActivity,
	SessionHistoryFingerprint,
	SessionHistoryResult,
	SessionIndexEntry,
} from "@/lib/sessions";
import type { ChatSessionRuntimeState } from "@/lib/chat-session-client";
import {
	connectRemoteEvents,
	deleteRemoteSession,
	generateRemoteSessionTitle,
	loadRemoteBootstrap,
	loadRemoteChatState,
	loadRemoteHistory,
	loadRemoteHistoryImage,
	loadRemoteExternalActivity,
	loadRemoteModels,
	loadRemoteSessions,
	searchRemoteFiles,
	sendRemoteChatCommand,
	startRemoteChat,
} from "./remote-client";

export class WebPiloClient implements PiloClient {
	constructor(private readonly token: string) {}

	bootstrap(): Promise<PiloClientBootstrap> {
		return loadRemoteBootstrap(this.token);
	}

	listSessions(projectId: string): Promise<SessionIndexEntry[]> {
		return loadRemoteSessions(this.token, projectId);
	}

	externalActivity(projectId: string): Promise<SessionExternalActivity[]> {
		return loadRemoteExternalActivity(this.token, projectId);
	}

	loadHistory(
		projectId: string,
		sessionPath: string,
		options?: PiloClientHistoryOptions,
	): Promise<SessionHistoryResult> {
		return loadRemoteHistory(this.token, projectId, sessionPath, options);
	}

	readHistoryImage(
		projectId: string,
		sessionPath: string,
		imageId: string,
		fingerprint?: SessionHistoryFingerprint,
	): Promise<Uint8Array<ArrayBuffer>> {
		return loadRemoteHistoryImage(
			this.token,
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
		return generateRemoteSessionTitle(this.token, projectId, message);
	}

	deleteSession(
		projectId: string,
		sessionPath: string,
	): Promise<SessionDeleteResult> {
		return deleteRemoteSession(this.token, projectId, sessionPath);
	}

	startChat(input: PiloClientStartChatInput): Promise<PiSessionSnapshot> {
		return startRemoteChat(this.token, input);
	}

	chatState(sessionKey: string): Promise<ChatSessionRuntimeState | null> {
		return loadRemoteChatState(this.token, sessionKey);
	}

	searchFiles(projectId: string, query: string): Promise<string[]> {
		return searchRemoteFiles(this.token, projectId, query);
	}

	loadModels(projectId: string): Promise<ProjectPiModels | null> {
		return loadRemoteModels(this.token, projectId);
	}

	sendChatCommand(
		sessionKey: string,
		command: Record<string, unknown>,
	): Promise<void> {
		return sendRemoteChatCommand(this.token, sessionKey, command);
	}

	connectEvents(options: PiloClientEventOptions): Promise<() => void> {
		return Promise.resolve(
			connectRemoteEvents(
				this.token,
				options.after,
				options.onMessage,
				options.onStatus,
			),
		);
	}
}
