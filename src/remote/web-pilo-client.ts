import type { PreferencePatch } from "@/lib/host-preferences";
import type { ThemeSettings, ThemeSettingsUpdate } from "@/lib/theme-settings";
import type { CacheKeepAliveSettings } from "@/lib/cache-keep-alive";
import type {
	NextPromptModel,
	NextPromptSettings,
	NextPromptRequest,
} from "@/lib/next-prompt";
import type {
	PromptEnhancementModel,
	PromptEnhancementSettings,
} from "@/lib/prompt-enhancement";
import type {
	PiloClient,
	PiloClientBootstrap,
	PiloClientEventOptions,
	PiloClientHistoryOptions,
	PiloClientStartChatInput,
} from "@/lib/api/pilo-client";
import type { PiSessionSnapshot, PiloRuntimeEvent } from "@/lib/api/pi-runtime";
import type { SessionReadState } from "@/lib/session-read-state";
import {
	isProjectPiModelsIncomplete,
	refreshProjectPiModels,
	type ProjectPiModels,
} from "@/lib/api/pi-models";
import { createRemoteModelProbe } from "./remote-model-probe";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@/lib/project-model-scope";
import type {
	SessionDeleteResult,
	SessionExternalActivity,
	SessionHistoryFingerprint,
	SessionHistoryResult,
	SessionIndexEntry,
	SessionSearchMatch,
} from "@/lib/api/sessions";
import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-client";
import {
	approveRemoteProjectMcpServer,
	connectRemoteEvents,
	deleteRemoteSession,
	generateRemoteSessionTitle,
	loadRemoteBootstrap,
	loadRemoteThemeSettings,
	loadRemotePreferences,
	saveRemotePreferences,
	saveRemoteThemeSettings,
	loadRemoteChatState,
	loadRemoteHistory,
	loadRemoteHistoryImage,
	loadRemoteProjectImage,
	uploadRemoteChatFile,
	loadRemoteExternalActivity,
	loadRemoteModels,
	saveRemoteModels,
	loadRemoteCacheKeepAliveSettings,
	saveRemoteCacheKeepAliveSettings,
	loadRemoteNextPromptSettings,
	saveRemoteNextPromptSettings,
	requestRemoteNextPrompt,
	loadRemotePromptEnhancementSettings,
	saveRemotePromptEnhancementSettings,
	enhanceRemotePrompt,
	loadRemoteModelScope,
	saveRemoteModelScope,
	loadRemoteSessions,
	loadRemoteSessionReadStates,
	markRemoteSessionRead,
	searchRemoteFiles,
	searchRemoteSessions,
	sendRemoteChatCommand,
	startRemoteChat,
	stopRemoteChat,
} from "./remote-client";

export class WebPiloClient implements PiloClient {
	private readonly chatEventListeners = new Set<
		(event: PiloRuntimeEvent) => void
	>();
	private readonly eventReadyListeners = new Set<() => void>();
	private eventsReady = false;
	private readonly catalogRequests = new Map<
		string,
		Promise<ProjectPiModels>
	>();

	constructor(private readonly token: string) {}

	bootstrap(): Promise<PiloClientBootstrap> {
		return loadRemoteBootstrap(this.token);
	}

	loadPreferences() {
		return loadRemotePreferences(this.token);
	}
	savePreferences(patch: PreferencePatch) {
		return saveRemotePreferences(this.token, patch);
	}

	loadThemeSettings(): Promise<ThemeSettings> {
		return loadRemoteThemeSettings(this.token);
	}

	saveThemeSettings(update: ThemeSettingsUpdate): Promise<ThemeSettings> {
		return saveRemoteThemeSettings(this.token, update);
	}

	listCachedSessions(projectId: string): Promise<SessionIndexEntry[]> {
		return loadRemoteSessions(this.token, projectId, true);
	}

	listSessions(projectId: string): Promise<SessionIndexEntry[]> {
		return loadRemoteSessions(this.token, projectId);
	}

	loadSessionReadStates(): Promise<SessionReadState[]> {
		return loadRemoteSessionReadStates(this.token);
	}

	markSessionRead(
		projectId: string,
		sessionPath: string,
		revision: number,
	): Promise<SessionReadState> {
		return markRemoteSessionRead(this.token, projectId, sessionPath, revision);
	}

	searchSessions(
		projectId: string,
		query: string,
		limit?: number,
	): Promise<SessionSearchMatch[]> {
		return searchRemoteSessions(this.token, projectId, query, limit);
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

	readProjectImage(
		projectId: string,
		path: string,
	): Promise<Uint8Array<ArrayBuffer>> {
		return loadRemoteProjectImage(this.token, projectId, path);
	}

	uploadChatFile(projectId: string, file: File): Promise<string> {
		return uploadRemoteChatFile(this.token, projectId, file);
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

	loadCacheKeepAliveSettings(
		connectionId: string,
	): Promise<CacheKeepAliveSettings[]> {
		return loadRemoteCacheKeepAliveSettings(this.token, connectionId);
	}

	saveCacheKeepAliveSettings(
		settings: CacheKeepAliveSettings,
	): Promise<CacheKeepAliveSettings> {
		return saveRemoteCacheKeepAliveSettings(this.token, settings);
	}

	loadNextPromptSettings(connectionId: string): Promise<NextPromptSettings> {
		return loadRemoteNextPromptSettings(this.token, connectionId);
	}

	saveNextPromptSettings(
		connectionId: string,
		enabled: boolean,
		model: NextPromptModel | null,
	): Promise<NextPromptSettings> {
		return saveRemoteNextPromptSettings(
			this.token,
			connectionId,
			enabled,
			model,
		);
	}

	requestNextPrompt(request: NextPromptRequest): Promise<void> {
		return requestRemoteNextPrompt(this.token, request);
	}

	loadPromptEnhancementSettings(
		connectionId: string,
	): Promise<PromptEnhancementSettings> {
		return loadRemotePromptEnhancementSettings(this.token, connectionId);
	}

	savePromptEnhancementSettings(
		connectionId: string,
		enabled: boolean,
		model: PromptEnhancementModel | null,
	): Promise<PromptEnhancementSettings> {
		return saveRemotePromptEnhancementSettings(
			this.token,
			connectionId,
			enabled,
			model,
		);
	}

	enhancePrompt(
		projectId: string,
		draft: string,
		model: PromptEnhancementModel | null,
	): Promise<string> {
		return enhanceRemotePrompt(this.token, projectId, draft, model);
	}

	startChat(input: PiloClientStartChatInput): Promise<PiSessionSnapshot> {
		return startRemoteChat(this.token, input);
	}

	stopChat(sessionKey: string, reason?: string): Promise<void> {
		return stopRemoteChat(this.token, sessionKey, reason);
	}

	chatState(sessionKey: string): Promise<ChatSessionRuntimeState | null> {
		return loadRemoteChatState(this.token, sessionKey);
	}

	searchFiles(projectId: string, query: string): Promise<string[]> {
		return searchRemoteFiles(this.token, projectId, query);
	}

	loadModels(projectId: string, force = false): Promise<ProjectPiModels> {
		const pending = this.catalogRequests.get(projectId);
		if (pending) return pending;
		const request = loadRemoteModels(this.token, projectId).then((cached) => {
			if (!force && cached && !isProjectPiModelsIncomplete(cached))
				return cached;
			return refreshProjectPiModels(projectId, {
				cached,
				createClient: (id, sessionId) =>
					createRemoteModelProbe(this, id, sessionId),
				persist: (snapshot) => saveRemoteModels(this.token, snapshot),
			});
		});
		this.catalogRequests.set(projectId, request);
		const clear = () => {
			this.catalogRequests.delete(projectId);
		};
		void request.then(clear, clear);
		return request;
	}

	loadModelScope(projectId: string): Promise<ProjectModelScope> {
		return loadRemoteModelScope(this.token, projectId);
	}

	saveModelScope(
		projectId: string,
		models: ProjectScopedModel[] | null,
	): Promise<ProjectModelScope> {
		return saveRemoteModelScope(this.token, projectId, models);
	}

	sendChatCommand(
		sessionKey: string,
		command: Record<string, unknown>,
	): Promise<void> {
		return sendRemoteChatCommand(this.token, sessionKey, command);
	}

	approveProjectMcpServer(
		projectId: string,
		serverName: string,
	): Promise<void> {
		return approveRemoteProjectMcpServer(this.token, projectId, serverName);
	}

	listenChatEvents(handler: (event: PiloRuntimeEvent) => void): () => void {
		this.chatEventListeners.add(handler);
		return () => {
			this.chatEventListeners.delete(handler);
		};
	}

	waitForEvents(): Promise<void> {
		if (this.eventsReady) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const ready = () => {
				clearTimeout(timer);
				this.eventReadyListeners.delete(ready);
				resolve();
			};
			const timer = setTimeout(() => {
				this.eventReadyListeners.delete(ready);
				reject(new Error("Pi catalog event connection timed out"));
			}, 10_000);
			this.eventReadyListeners.add(ready);
		});
	}

	connectEvents(options: PiloClientEventOptions): Promise<() => void> {
		return Promise.resolve(
			connectRemoteEvents(
				this.token,
				options.after,
				(message) => {
					if (message.type === "events") {
						for (const event of message.events) {
							for (const listener of this.chatEventListeners) listener(event);
						}
					}
					options.onMessage(message);
				},
				(connected) => {
					this.eventsReady = connected;
					if (connected) {
						for (const ready of this.eventReadyListeners) ready();
					}
					options.onStatus(connected);
				},
			),
		);
	}
}
