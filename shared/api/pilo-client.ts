import type {
	PreferencePatch,
	PreferencesSnapshot,
} from "@shared/host-preferences-types";
import type {
	ThemeSettings,
	ThemeSettingsUpdate,
} from "@shared/theme-settings-types";
import type { CacheKeepAliveSettings } from "@shared/cache-keep-alive";
import type {
	NextPromptModel,
	NextPromptSettings,
	NextPromptRequest,
} from "@shared/next-prompt-types";
import type {
	PromptEnhancementModel,
	PromptEnhancementSettings,
} from "@shared/prompt-enhancement-types";
import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";
import type {
	PiModel,
	PiSessionSnapshot,
	PiloRuntimeEvent,
} from "@shared/api/pi-runtime-types";
import type { ProjectPiModels } from "@shared/api/pi-models-types";
import type { Project } from "@shared/api/projects-types";
import type { SessionReadState } from "@shared/session-read-state";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@shared/project-model-scope";
import type {
	SessionDeleteResult,
	SessionHistoryFingerprint,
	SessionHistoryResult,
	SessionIndexEntry,
	SessionSearchMatch,
} from "@shared/api/sessions-types";

export type PiloClientBootstrap = {
	projects: Project[];
	chatSessions: ChatSessionRuntimeState[];
	latestSequence: number;
	localPiResources?: Record<string, boolean>;
};

export type PiloClientStartChatInput = {
	projectId: string;
	sessionKey: string;
	sessionPath?: string;
	noSession?: boolean;
	builtinExtensions?: { id: "model-catalog" }[];
};

export type PiloClientHistoryOptions = {
	startMessage?: number;
	messageLimit?: number;
	includeMessageIndex?: boolean;
	fingerprint?: SessionHistoryFingerprint;
};

export type PiloClientEvent = PiloRuntimeEvent & { sequence: number };

export type PiloClientEventMessage =
	| { type: "hello"; latestSequence: number; deviceId?: string }
	| { type: "events"; events: PiloClientEvent[] }
	| { type: "resyncRequired"; latestSequence: number };

export type PiloClientEventOptions = {
	after?: number;
	onMessage: (message: PiloClientEventMessage) => void;
	onStatus: (connected: boolean) => void;
};

export interface PiloClient {
	loadPreferences(): Promise<PreferencesSnapshot>;
	savePreferences(patch: PreferencePatch): Promise<PreferencesSnapshot>;
	bootstrap(): Promise<PiloClientBootstrap>;
	loadThemeSettings(): Promise<ThemeSettings>;
	saveThemeSettings(update: ThemeSettingsUpdate): Promise<ThemeSettings>;
	listSessions(projectId: string): Promise<SessionIndexEntry[]>;
	/** The Host's session index as it stands, without a scan. */
	listCachedSessions(projectId: string): Promise<SessionIndexEntry[]>;
	loadSessionReadStates(): Promise<SessionReadState[]>;
	markSessionRead(
		projectId: string,
		sessionPath: string,
		revision: number,
	): Promise<SessionReadState>;
	searchSessions(
		projectId: string,
		query: string,
		limit?: number,
	): Promise<SessionSearchMatch[]>;
	loadHistory(
		projectId: string,
		sessionPath: string,
		options?: PiloClientHistoryOptions,
	): Promise<SessionHistoryResult>;
	readHistoryImage(
		projectId: string,
		sessionPath: string,
		imageId: string,
		fingerprint?: SessionHistoryFingerprint,
	): Promise<Uint8Array<ArrayBuffer>>;
	readProjectImage(
		projectId: string,
		path: string,
	): Promise<Uint8Array<ArrayBuffer>>;
	generateSessionTitle(
		projectId: string,
		message: string,
	): Promise<string | null>;
	deleteSession(
		projectId: string,
		sessionPath: string,
	): Promise<SessionDeleteResult>;
	/** Fresh Pi user catalog for this connection, independent of project caches. */
	loadConnectionModels(connectionId: string): Promise<PiModel[]>;
	/** Host-cached Pi model catalog snapshot; null when the project has none. */
	loadModels(projectId: string): Promise<ProjectPiModels | null>;
	loadModelScope(projectId: string): Promise<ProjectModelScope>;
	saveModelScope(
		projectId: string,
		models: ProjectScopedModel[] | null,
	): Promise<ProjectModelScope>;
	loadCacheKeepAliveSettings(
		connectionId: string,
	): Promise<CacheKeepAliveSettings[]>;
	saveCacheKeepAliveSettings(
		settings: CacheKeepAliveSettings,
	): Promise<CacheKeepAliveSettings>;
	loadNextPromptSettings(connectionId: string): Promise<NextPromptSettings>;
	saveNextPromptSettings(
		connectionId: string,
		enabled: boolean,
		model: NextPromptModel | null,
	): Promise<NextPromptSettings>;
	requestNextPrompt(request: NextPromptRequest): Promise<void>;
	loadPromptEnhancementSettings(
		connectionId: string,
	): Promise<PromptEnhancementSettings>;
	savePromptEnhancementSettings(
		connectionId: string,
		enabled: boolean,
		model: PromptEnhancementModel | null,
	): Promise<PromptEnhancementSettings>;
	enhancePrompt(
		projectId: string,
		draft: string,
		model: PromptEnhancementModel | null,
	): Promise<string>;
	startChat(input: PiloClientStartChatInput): Promise<PiSessionSnapshot>;
	stopChat(sessionKey: string, reason?: string): Promise<void>;
	chatState(sessionKey: string): Promise<ChatSessionRuntimeState | null>;
	sendChatCommand(
		sessionKey: string,
		command: Record<string, unknown>,
	): Promise<void>;
	connectEvents(options: PiloClientEventOptions): Promise<() => void>;
}
