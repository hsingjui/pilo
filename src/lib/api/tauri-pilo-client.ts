import type { ThemeSettings, ThemeSettingsUpdate } from "@/lib/theme-settings";
import type { CacheKeepAliveSettings } from "@/lib/cache-keep-alive";
import type {
	NextPromptModel,
	NextPromptSettings,
	NextPromptRequest,
} from "@/lib/next-prompt";
import { invoke } from "@tauri-apps/api/core";

import {
	listChatSessionRuntimeStates,
	type ChatSessionRuntimeState,
} from "@/lib/api/chat-session-client";
import {
	listenRuntimeEvents,
	type PiSessionSnapshot,
} from "@/lib/api/pi-runtime";
import {
	type PiloClient,
	type PiloClientBootstrap,
	type PiloClientEventOptions,
	type PiloClientHistoryOptions,
	type PiloClientStartChatInput,
} from "@/lib/api/pilo-client";
import { listProjects } from "@/lib/api/projects";
import type { SessionReadState } from "@/lib/session-read-state";
import { readProjectImage } from "@/lib/api/files";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@/lib/project-model-scope";
import {
	getCachedProjectPiModels,
	hydrateProjectPiModels,
	type ProjectPiModels,
} from "@/lib/api/pi-models";
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
} from "@/lib/api/sessions";
import type { PromptEnhanceModel } from "@/lib/prompt-enhance";

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

	loadThemeSettings(): Promise<ThemeSettings> {
		return invoke<ThemeSettings>("theme_settings_get");
	}

	saveThemeSettings(update: ThemeSettingsUpdate): Promise<ThemeSettings> {
		return invoke<ThemeSettings>("theme_settings_set", { update });
	}

	loadSessionReadStates(): Promise<SessionReadState[]> {
		return invoke<SessionReadState[]>("session_read_states");
	}

	markSessionRead(
		projectId: string,
		sessionPath: string,
		revision: number,
	): Promise<SessionReadState> {
		return invoke<SessionReadState>("session_mark_read", {
			projectId,
			sessionPath,
			revision,
		});
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

	readProjectImage(
		projectId: string,
		path: string,
	): Promise<Uint8Array<ArrayBuffer>> {
		return readProjectImage(projectId, path);
	}

	generateSessionTitle(
		projectId: string,
		message: string,
	): Promise<string | null> {
		return requestSessionTitle(projectId, message);
	}

	enhancePrompt(
		projectId: string,
		draft: string,
		model: PromptEnhanceModel | null,
	): Promise<string> {
		return invoke<string>("prompt_enhance", { projectId, draft, model });
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

	loadModelScope(projectId: string): Promise<ProjectModelScope> {
		return invoke<ProjectModelScope>("project_model_scope_get", { projectId });
	}

	saveModelScope(
		projectId: string,
		models: ProjectScopedModel[] | null,
	): Promise<ProjectModelScope> {
		return invoke<ProjectModelScope>("project_model_scope_set", {
			projectId,
			models,
		});
	}

	loadCacheKeepAliveSettings(
		connectionId: string,
	): Promise<CacheKeepAliveSettings[]> {
		return invoke("cache_keep_alive_settings_list", { connectionId });
	}

	saveCacheKeepAliveSettings(
		settings: CacheKeepAliveSettings,
	): Promise<CacheKeepAliveSettings> {
		return invoke("cache_keep_alive_settings_set", { settings });
	}

	loadNextPromptSettings(connectionId: string): Promise<NextPromptSettings> {
		return invoke<NextPromptSettings>("next_prompt_settings_get", {
			connectionId,
		});
	}

	saveNextPromptSettings(
		connectionId: string,
		enabled: boolean,
		model: NextPromptModel | null,
	): Promise<NextPromptSettings> {
		return invoke<NextPromptSettings>("next_prompt_settings_set", {
			connectionId,
			enabled,
			model,
		});
	}

	requestNextPrompt(request: NextPromptRequest): Promise<void> {
		return invoke<void>("next_prompt_request", { request });
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
