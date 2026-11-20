import type {
	PiloClientEvent,
	PiloClientEventOptions,
	PiloClientStartChatInput,
} from "@/lib/api/pilo-client";
import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-types";
import type { ProjectPiModels } from "@/lib/api/pi-models-types";
import type { FsEntry } from "@/lib/api/files-types";
import type {
	Connection,
	PiModel,
	PiSessionSnapshot,
} from "@/lib/api/pi-runtime-types";
import type { ConnectionNamingModel } from "@/lib/api/sessions-types";
import type { CacheKeepAliveSettings } from "@/lib/cache-keep-alive";
import type {
	NextPromptModel,
	NextPromptSettings,
} from "@/lib/next-prompt-types";
import type {
	PromptEnhancementModel,
	PromptEnhancementSettings,
} from "@/lib/prompt-enhancement-types";
import type { Project } from "@/lib/api/projects-types";
import type { ConversationEvent } from "@/lib/chat/conversation-types";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@/lib/project-model-scope";
import type {
	SessionDeleteResult,
	SessionHistory,
	SessionHistoryResult,
	SessionIndexEntry,
	SessionSearchMatch,
	SessionUiStateUpdate,
} from "@/lib/api/sessions-types";
import type {
	HostPreferenceValues,
	PreferencePatch,
	PreferencesSnapshot,
} from "@/lib/host-preferences-types";
import type { SessionReadState } from "@/lib/session-read-state";
import type {
	ThemeSettings,
	ThemeSettingsUpdate,
} from "@/lib/theme-settings-types";
import type { SavedCustomTheme } from "@/lib/theme-custom";
import type { PiCommandClient } from "../client/chat-rpc";
import type {
	NshPiloClient,
	NshPiloClientBootstrap,
} from "../client/nsh-pilo-client";
import type { AppStoreClient } from "../state/app-store";
import type { ChatTranscriptClient } from "../state/chat-transcript-store";

/** The native calls the scripted client answers beyond the app stores. */
export type ScriptedChatClient = PiCommandClient & {
	listConnections: () => Promise<Connection[]>;
	addProject: (connectionId: string, path: string) => Promise<Project>;
	readConnectionDir: (
		connectionId: string,
		path?: string,
	) => Promise<FsEntry[]>;
	pickLocalProjectDirectory: () => Promise<string | null>;
	startChat: (input: PiloClientStartChatInput) => Promise<PiSessionSnapshot>;
	stopChat: (sessionKey: string, reason?: string) => Promise<void>;
	loadModels: (projectId: string) => Promise<ProjectPiModels | null>;
	saveModels: (snapshot: ProjectPiModels) => Promise<ProjectPiModels>;
	loadModelScope: (projectId: string) => Promise<ProjectModelScope>;
	saveModelScope: (
		projectId: string,
		models: ProjectScopedModel[] | null,
	) => Promise<ProjectModelScope>;
	updateSessionUiState: (
		sessionPath: string,
		update: SessionUiStateUpdate,
		projectId?: string,
	) => Promise<SessionIndexEntry>;
	searchSessions: (
		projectId: string,
		query: string,
		limit?: number,
	) => Promise<SessionSearchMatch[]>;
	deleteSession: (
		projectId: string,
		sessionPath: string,
	) => Promise<SessionDeleteResult>;
};

/** The native calls the settings panes make; the script answers them. */
export type ScriptedSettingsClient = Pick<
	NshPiloClient,
	| "loadPreferences"
	| "savePreferences"
	| "saveThemeSettings"
	| "loadConnectionModels"
	| "loadNamingModels"
	| "saveNamingModel"
	| "loadCacheKeepAliveSettings"
	| "saveCacheKeepAliveSettings"
	| "loadNextPromptSettings"
	| "saveNextPromptSettings"
	| "loadPromptEnhancementSettings"
	| "savePromptEnhancementSettings"
>;

export type AppScript = {
	projects?: Project[];
	preferences?: PreferencesSnapshot;
	themeSettings?: ThemeSettings;
	/** A project's saved sessions; none when left out. */
	sessions?: (projectId: string) => Promise<SessionIndexEntry[]>;
	chatSessions?: ChatSessionRuntimeState[];
	/** A saved session's settled history; no events when left out. */
	history?: (sessionPath: string) => Promise<ConversationEvent[]>;
	/** Metadata merged into the `loadHistory` answer's `history`. */
	historyMeta?: Partial<SessionHistory>;
	readStates?: SessionReadState[];
	/** Replaces a bootstrap's answer; `undefined` answers from the script. */
	bootstrap?: (attempt: number) => Promise<NshPiloClientBootstrap> | undefined;
	/**
	 * Answers a command sent over the chat command channel. A reply object is
	 * delivered as an `rpc_message` response carrying the command's `id`;
	 * `undefined` leaves the command unanswered (its rpc times out).
	 */
	onCommand?: (
		sessionKey: string,
		command: Record<string, unknown>,
	) => Record<string, unknown> | undefined;
	/** The snapshot `startChat` resolves with; a running one by default. */
	onStartChat?: (
		input: PiloClientStartChatInput,
	) => PiSessionSnapshot | Promise<PiSessionSnapshot>;
	/**
	 * The transcript snapshot `chatTranscriptSnapshot` resolves with;
	 * "no Pi is running" when left out, as before.
	 */
	onSnapshot?: (
		sessionKey: string,
	) => import("../client/nsh-pilo-client").ChatTranscriptSnapshot | undefined;
	/** A project's saved model catalog; `loadModels` answers null otherwise. */
	models?: Record<string, ProjectPiModels>;
	/** A project's saved model scope; null inherits Pi when left out. */
	modelScopes?: Record<string, ProjectModelScope | null>;
	/** The catalog `loadConnectionModels` answers per connection. */
	connectionModels?: Record<string, PiModel[]>;
	/** The naming models `loadNamingModels` answers. */
	namingModels?: ConnectionNamingModel[];
	/** A connection's saved cache keep-alive policies. */
	cacheKeepAlive?: Record<string, CacheKeepAliveSettings[]>;
	/** A connection's saved next-prompt settings; disabled when left out. */
	nextPrompt?: Record<string, NextPromptSettings>;
	/** A connection's saved prompt enhancement settings. */
	promptEnhancement?: Record<string, PromptEnhancementSettings>;
	/** The catalog `removeProject` resolves with; minus the project otherwise. */
	onRemoveProject?: (projectId: string) => Project[];
	/** The connections `listConnections` resolves with; Local otherwise. */
	connections?: Connection[];
	/** The project `addProject` resolves with; a derived one by default. */
	onAddProject?: (connectionId: string, path: string) => Project;
	/** The folders `readConnectionDir` resolves with; none by default. */
	onReadConnectionDir?: (connectionId: string, path?: string) => FsEntry[];
	/** The path `pickLocalProjectDirectory` resolves with; null by default. */
	onPickLocalProjectDirectory?: () => string | null;
	/** The index entry `updateSessionUiState` resolves with. */
	onUpdateSessionUiState?: (
		sessionPath: string,
		update: SessionUiStateUpdate,
		projectId?: string,
	) => SessionIndexEntry;
	/** The message matches `searchSessions` resolves with; none when left out. */
	onSearchSessions?: (
		projectId: string,
		query: string,
		limit?: number,
	) => SessionSearchMatch[] | Promise<SessionSearchMatch[]>;
	/** What `deleteSession` resolves with; `{ method: "trash" }` by default. */
	onDeleteSession?: (
		projectId: string,
		sessionPath: string,
	) => SessionDeleteResult;
};

/** A new Host's preferences and theme, as far as the shell reads them. */
export const HOST_DEFAULT_VALUES = {
	locale: "en-US",
	pageFontFamily: "inter",
	codeFontFamily: "jetbrains-mono",
	codeFontSize: 14,
} as HostPreferenceValues;

const HOST_DEFAULT_PREFERENCES: PreferencesSnapshot = {
	revision: 0,
	values: HOST_DEFAULT_VALUES,
};

const HOST_DEFAULT_THEME = {
	revision: 0,
	theme: "system",
	themeFamily: "lody",
} as ThemeSettings;

/** A client for the app store that answers from `script`, without a runtime. */
export function scriptedClient(script: AppScript = {}) {
	const listeners = new Set<PiloClientEventOptions>();
	const projects = script.projects ?? [];
	const commands: [string, Record<string, unknown>][] = [];
	const savedModels = new Map<string, ProjectPiModels>();
	const modelScopes = new Map(Object.entries(script.modelScopes ?? {}));
	const namingModels = new Map(
		(script.namingModels ?? []).map((model) => [model.connectionId, model]),
	);
	const keepAlivePolicies = new Map(
		Object.entries(script.cacheKeepAlive ?? {}),
	);
	const nextPromptSettings = new Map(Object.entries(script.nextPrompt ?? {}));
	const promptEnhancementSettings = new Map(
		Object.entries(script.promptEnhancement ?? {}),
	);
	const running = new Set<string>();
	const removed: string[] = [];
	/** UI state written through `updateSessionUiState`, by session path. */
	const uiState = new Map<string, SessionUiStateUpdate>();
	/** Session paths deleted through `deleteSession`, gone from `listSessions`. */
	const deleted = new Set<string>();
	let attempts = 0;
	let sequence = 0;
	let closed = false;
	let preferences = script.preferences ?? HOST_DEFAULT_PREFERENCES;
	let themeSettings = script.themeSettings ?? HOST_DEFAULT_THEME;
	/** Every `savePreferences` patch, in order. */
	const preferencePatches: PreferencePatch[] = [];
	/** Delivers runtime events to the app, in order. */
	const emit = (...events: object[]) => {
		const message = {
			type: "events" as const,
			events: events.map(
				(event) => ({ ...event, sequence: ++sequence }) as PiloClientEvent,
			),
		};
		for (const listener of listeners) listener.onMessage(message);
	};
	const client: AppStoreClient &
		ChatTranscriptClient &
		ScriptedChatClient &
		ScriptedSettingsClient = {
		get closed() {
			return closed;
		},
		bootstrap() {
			attempts += 1;
			return (
				script.bootstrap?.(attempts) ??
				Promise.resolve({
					projects,
					chatSessions: script.chatSessions ?? [],
					latestSequence: sequence,
					preferences: script.preferences ?? HOST_DEFAULT_PREFERENCES,
				})
			);
		},
		// A scripted chat keeps the state the bootstrap gave it.
		chatState: (sessionKey) =>
			Promise.resolve(
				script.chatSessions?.find((chat) => chat.sessionKey === sessionKey) ??
					null,
			),
		// No Pi runs for a scripted chat unless the script says otherwise.
		chatTranscriptSnapshot: (sessionKey) => {
			const snapshot = script.onSnapshot?.(sessionKey);
			return snapshot
				? Promise.resolve(snapshot)
				: Promise.reject(new Error("no Pi is running"));
		},
		startChat(input) {
			running.add(input.sessionKey);
			return Promise.resolve(
				script.onStartChat?.(input) ?? {
					generation: 0,
					state: "running",
					connection: null,
					projectId: input.projectId,
				},
			);
		},
		stopChat(sessionKey) {
			running.delete(sessionKey);
			return Promise.resolve();
		},
		sendChatCommand(sessionKey, command) {
			commands.push([sessionKey, command]);
			const reply = script.onCommand?.(sessionKey, command);
			if (reply !== undefined && typeof command.id === "string") {
				const message = { type: "response", id: command.id, ...reply };
				queueMicrotask(() =>
					emit({ type: "rpc_message", sessionKey, message }),
				);
			}
			return Promise.resolve();
		},
		loadModels: (projectId) =>
			Promise.resolve(
				savedModels.get(projectId) ?? script.models?.[projectId] ?? null,
			),
		saveModels(snapshot) {
			savedModels.set(snapshot.projectId, snapshot);
			return Promise.resolve(snapshot);
		},
		loadModelScope: (projectId) =>
			Promise.resolve(
				modelScopes.get(projectId) ?? {
					projectId,
					models: null,
					updatedAtMs: 0,
				},
			),
		saveModelScope(projectId, models: ProjectScopedModel[] | null) {
			const scope = {
				projectId,
				models,
				updatedAtMs: Date.now(),
			} as ProjectModelScope;
			modelScopes.set(projectId, scope);
			emit({ type: "project_model_scope_changed", scope });
			return Promise.resolve(scope);
		},
		updateSessionUiState(sessionPath, update, projectId) {
			uiState.set(sessionPath, update);
			return Promise.resolve(
				script.onUpdateSessionUiState?.(sessionPath, update, projectId) ??
					({
						sessionPath,
						pinned: update.pinned,
						titleOverride: update.titleOverride,
					} as SessionIndexEntry),
			);
		},
		searchSessions: (projectId, query, limit) =>
			Promise.resolve(script.onSearchSessions?.(projectId, query, limit) ?? []),
		deleteSession(projectId, sessionPath) {
			deleted.add(sessionPath);
			return Promise.resolve(
				script.onDeleteSession?.(projectId, sessionPath) ?? {
					method: "trash" as const,
				},
			);
		},
		loadHistory: async (_projectId, sessionPath) =>
			({
				history: {
					events: (await script.history?.(sessionPath)) ?? [],
					...script.historyMeta,
				},
				fingerprint: null,
			}) as SessionHistoryResult,
		listProjects: () => Promise.resolve(projects),
		listConnections: () =>
			Promise.resolve(
				script.connections ?? [
					{ id: "local", name: "Local", kind: { type: "local" } } as Connection,
				],
			),
		addProject: (connectionId, path) => {
			const created =
				script.onAddProject?.(connectionId, path) ??
				({
					id: `added-${path}`,
					name: path.replace(/\/+$/, "").split("/").pop() ?? path,
					path,
					connectionId,
				} as unknown as Project);
			projects.push(created);
			return Promise.resolve(created);
		},
		readConnectionDir: (connectionId, path) =>
			Promise.resolve(script.onReadConnectionDir?.(connectionId, path) ?? []),
		pickLocalProjectDirectory: () =>
			Promise.resolve(script.onPickLocalProjectDirectory?.() ?? null),
		removeProject: (projectId) => {
			removed.push(projectId);
			return Promise.resolve(
				script.onRemoveProject?.(projectId) ??
					projects.filter((project) => project.id !== projectId),
			);
		},
		listSessions: async (projectId) => {
			const listed = (await script.sessions?.(projectId)) ?? [];
			return listed
				.filter((entry) => !deleted.has(entry.sessionPath))
				.map((entry) => ({ ...entry, ...uiState.get(entry.sessionPath) }));
		},
		loadConnectionModels: (connectionId) =>
			Promise.resolve(script.connectionModels?.[connectionId] ?? []),
		loadNamingModels: () => Promise.resolve([...namingModels.values()]),
		saveNamingModel(connectionId, provider, modelId) {
			const model =
				provider && modelId ? { connectionId, provider, modelId } : null;
			if (model) namingModels.set(connectionId, model);
			else namingModels.delete(connectionId);
			return Promise.resolve(model);
		},
		loadCacheKeepAliveSettings: (connectionId) =>
			Promise.resolve(keepAlivePolicies.get(connectionId) ?? []),
		saveCacheKeepAliveSettings(settings) {
			const saved = { ...settings, updatedAtMs: Date.now() };
			const rows = (keepAlivePolicies.get(settings.connectionId) ?? []).filter(
				(row) =>
					row.provider !== settings.provider ||
					row.modelId !== settings.modelId,
			);
			keepAlivePolicies.set(settings.connectionId, [...rows, saved]);
			return Promise.resolve(saved);
		},
		loadNextPromptSettings: (connectionId) =>
			Promise.resolve(
				nextPromptSettings.get(connectionId) ?? {
					connectionId,
					enabled: false,
					model: null,
					updatedAtMs: 0,
				},
			),
		saveNextPromptSettings(
			connectionId,
			enabled: boolean,
			model: NextPromptModel | null,
		) {
			const saved = {
				connectionId,
				enabled,
				model,
				updatedAtMs: Date.now(),
			};
			nextPromptSettings.set(connectionId, saved);
			return Promise.resolve(saved);
		},
		loadPromptEnhancementSettings: (connectionId) =>
			Promise.resolve(
				promptEnhancementSettings.get(connectionId) ?? {
					connectionId,
					enabled: false,
					model: null,
					updatedAtMs: 0,
				},
			),
		savePromptEnhancementSettings(
			connectionId,
			enabled: boolean,
			model: PromptEnhancementModel | null,
		) {
			const saved = {
				connectionId,
				enabled,
				model,
				updatedAtMs: Date.now(),
			};
			promptEnhancementSettings.set(connectionId, saved);
			return Promise.resolve(saved);
		},
		loadSessionReadStates: () => Promise.resolve(script.readStates ?? []),
		loadPreferences: () => Promise.resolve(preferences),
		savePreferences(patch, _initial) {
			preferencePatches.push(patch);
			const { keyboardShortcuts, ...rest } = patch;
			preferences = {
				revision: preferences.revision + 1,
				values: {
					...preferences.values,
					...rest,
					keyboardShortcuts: {
						...preferences.values.keyboardShortcuts,
						...keyboardShortcuts,
					},
				},
			};
			emit({ type: "preferences_changed", settings: preferences });
			return Promise.resolve(preferences);
		},
		loadThemeSettings: () => Promise.resolve(themeSettings),
		saveThemeSettings(update) {
			const { saveCustomTheme, deleteCustomTheme, ...rest } = update;
			let savedCustomThemes = themeSettings.savedCustomThemes;
			if (saveCustomTheme)
				savedCustomThemes = [
					...(savedCustomThemes ?? []).filter(
						(theme) => theme.name !== saveCustomTheme.name,
					),
					saveCustomTheme as SavedCustomTheme,
				];
			if (deleteCustomTheme)
				savedCustomThemes = (savedCustomThemes ?? []).filter(
					(theme) => theme.name !== deleteCustomTheme,
				);
			themeSettings = {
				...themeSettings,
				...rest,
				savedCustomThemes,
				revision: themeSettings.revision + 1,
			};
			emit({ type: "theme_settings_changed", settings: themeSettings });
			return Promise.resolve(themeSettings);
		},
		markSessionRead(projectId, sessionPath, revision) {
			const read = script.readStates?.find(
				(state) =>
					state.projectId === projectId && state.sessionPath === sessionPath,
			);
			if (!read) return Promise.reject(new Error("no session to mark"));
			const state = { ...read, readRevision: revision };
			emit({ type: "session_read_state_changed", state });
			return Promise.resolve(state);
		},
		connectEvents(options) {
			listeners.add(options);
			options.onStatus(true);
			return Promise.resolve(() => {
				listeners.delete(options);
			});
		},
	};
	return {
		client,
		emit,
		/** Every `savePreferences` patch, in order. */
		preferencePatches,
		/** Every command sent through `sendChatCommand`, in order. */
		commands,
		/** Every project `removeProject` was asked to drop, in order. */
		removed,
		/** The runtime shuts down: its event stream ends for good. */
		close() {
			closed = true;
			for (const listener of listeners) listener.onStatus(false);
		},
	};
}
