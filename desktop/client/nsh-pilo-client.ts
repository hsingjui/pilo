import type { Pilo } from "app/native";
import process from "process";

import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";
import type { FsEntry } from "@shared/api/files-types";
import type { ProjectPiModels } from "@shared/api/pi-models-types";
import type {
	Connection,
	PiModel,
	PiloRuntimeEvent,
	PiSessionSnapshot,
	WslDistribution,
} from "@shared/api/pi-runtime-types";
import type {
	PiloClient,
	PiloClientBootstrap,
	PiloClientEvent,
	PiloClientEventMessage,
	PiloClientEventOptions,
	PiloClientHistoryOptions,
	PiloClientStartChatInput,
} from "@shared/api/pilo-client";
import type {
	ConnectionHealth,
	ConnectionTestResult,
	PiExecutableInfo,
	SshAgentIdentity,
	SshConnectionInfo,
	WslConnectionInfo,
} from "@shared/api/connections-types";
import type { Project } from "@shared/api/projects-types";
import type { ConnectionNamingModel } from "@shared/api/sessions-types";
import type {
	SessionDeleteResult,
	SessionExternalActivity,
	SessionHistoryFingerprint,
	SessionHistoryResult,
	SessionIndexEntry,
	SessionSearchMatch,
	SessionUiStateUpdate,
} from "@shared/api/sessions-types";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@shared/project-model-scope";
import type { CacheKeepAliveSettings } from "@shared/cache-keep-alive";
import type {
	NextPromptModel,
	NextPromptRequest,
	NextPromptSettings,
} from "@shared/next-prompt-types";
import type {
	PromptEnhancementModel,
	PromptEnhancementSettings,
} from "@shared/prompt-enhancement-types";
import type {
	PreferencePatch,
	PreferencesSnapshot,
} from "@shared/host-preferences-types";
import type {
	RemoteAccessAddress,
	RemoteHostState,
} from "@shared/api/remote-types";
import type { SystemFontFamily } from "@shared/font-settings";
import type {
	ThemeSettings,
	ThemeSettingsUpdate,
} from "@shared/theme-settings-types";

/**
 * The native calls the client makes; a test can pass a stand-in. Font
 * enumeration is optional so stand-ins without it fall back to built-ins.
 */
export type PiloNative = Pick<
	Pilo,
	| "bootstrap"
	| "nextEvents"
	| "startChat"
	| "stopChat"
	| "chatState"
	| "chatTranscriptSnapshot"
	| "sendChatCommand"
	| "listProjects"
	| "addProject"
	| "removeProject"
	| "listConnections"
	| "readConnectionDir"
	| "pickLocalProjectDirectory"
	| "getLocalConnection"
	| "updateConnectionSettings"
	| "setConnectionShownInHome"
	| "getConnectionHealth"
	| "probeConnectionPi"
	| "testLocalConnection"
	| "listSshConnections"
	| "listSshAgentIdentities"
	| "saveSshConnection"
	| "getSshConnectionPassword"
	| "removeSshConnection"
	| "testSshConnection"
	| "testSshConnectionDraft"
	| "listWslDistributions"
	| "listWslConnections"
	| "saveWslConnection"
	| "removeWslConnection"
	| "testWslConnection"
	| "listSessions"
	| "searchSessions"
	| "searchProjectFiles"
	| "uploadChatFile"
	| "removeChatFile"
	| "generateSessionTitle"
	| "deleteSession"
	| "externalSessionActivity"
	| "updateSessionUiState"
	| "loadHistory"
	| "readHistoryImage"
	| "readProjectImage"
	| "loadConnectionModels"
	| "loadModels"
	| "saveModels"
	| "loadModelScope"
	| "saveModelScope"
	| "loadNamingModels"
	| "saveNamingModel"
	| "loadCacheKeepAliveSettings"
	| "saveCacheKeepAliveSettings"
	| "loadNextPromptSettings"
	| "saveNextPromptSettings"
	| "requestNextPrompt"
	| "loadPromptEnhancementSettings"
	| "savePromptEnhancementSettings"
	| "enhancePrompt"
	| "loadSessionReadStates"
	| "markSessionRead"
	| "loadPreferences"
	| "savePreferences"
	| "loadThemeSettings"
	| "saveThemeSettings"
	| "remoteHostState"
	| "remoteLanAddresses"
	| "remoteSetEnabled"
	| "remoteSetPort"
	| "remoteSetPublicBaseUrl"
	| "remoteSetAddresses"
	| "remotePairingRegenerate"
	| "remoteDeviceRevoke"
	| "remoteDeviceRename"
	| "openLogDirectory"
	| "shutdown"
> &
	Partial<
		Pick<
			Pilo,
			| "systemFontFamilies"
			| "openTerminal"
			| "writeTerminal"
			| "resizeTerminal"
			| "closeTerminal"
			| "nextTerminalEvents"
		>
	>;

/** A shell the runtime runs in a project's environment. */
export type TerminalInfo = { id: string; projectId: string; title: string };

/** What a terminal reports; `output` carries base64 bytes. */
export type TerminalEvent =
	| { type: "output"; terminalId: string; data: string }
	| { type: "exit"; terminalId: string }
	| { type: "error"; terminalId: string; message: string };

export type NshPiloClientBootstrap = PiloClientBootstrap & {
	preferences: PreferencesSnapshot;
};

/** The messages of a session's saved history a transcript snapshot reads. */
export type ChatTranscriptWindow = Omit<
	PiloClientHistoryOptions,
	"fingerprint"
>;

/**
 * A chat's transcript at one point of the event stream. Unless `live` is
 * truncated, every event of the session up to `eventSequence` is already in
 * `history` or `live`.
 */
export type ChatTranscriptSnapshot = {
	eventSequence: number;
	sessionKey: string;
	generation: number;
	history: SessionHistoryResult;
	live:
		| { type: "idle" }
		/** The turn in progress, as its events in order up to the cut. */
		| { type: "active"; events: PiloRuntimeEvent[] }
		/**
		 * The running turn cannot be rebuilt from this cut, and `history` is
		 * empty rather than the session's. Load the transcript again once the
		 * turn has settled.
		 */
		| { type: "truncated" };
};

/**
 * Image bytes as the native module returns them: over an `ArrayBuffer`, never
 * a shared one, which its generated declaration does not say.
 */
type ImageBytes = Uint8Array<ArrayBuffer>;

/** What `nextEvents` resolves with, as `desktop/README.md` lists it. */
type NativeEventBatch =
	| { type: "events"; events: PiloClientEvent[] }
	| { type: "gap"; firstMissed: number; lastMissed: number }
	| { type: "closed" };

/** Well under the native queue bound of 2,048 events. */
const EVENT_BATCH_SIZE = 256;

/** Adapts the nsh native module's JSON to the shared `PiloClient` types. */
export class NshPiloClient implements PiloClient {
	private readonly pilo: PiloNative;
	private readonly noSessionStarts = new Map<string, Set<Promise<unknown>>>();
	private readonly listeners = new Set<PiloClientEventOptions>();
	private polling = false;
	private streamClosed = false;
	/** A batch that arrived after its last listener left, for the next one. */
	private held: NativeEventBatch | undefined;

	constructor(pilo: PiloNative) {
		this.pilo = pilo;
	}

	async bootstrap(): Promise<NshPiloClientBootstrap> {
		const snapshot = await this.pilo.bootstrap();
		return {
			projects: snapshot.projects as Project[],
			chatSessions: snapshot.chatSessions as ChatSessionRuntimeState[],
			latestSequence: snapshot.eventSequence,
			preferences: snapshot.preferences as PreferencesSnapshot,
		};
	}

	async listProjects(): Promise<Project[]> {
		return (await this.pilo.listProjects()) as Project[];
	}

	/** The connections a project can live on (local, WSL, SSH). */
	async listConnections(): Promise<Connection[]> {
		return (await this.pilo.listConnections()) as Connection[];
	}

	/** Adds the connection's directory to the catalog. */
	async addProject(connectionId: string, path: string): Promise<Project> {
		return (await this.pilo.addProject(connectionId, path)) as Project;
	}

	/** Removes the project; the answer is the catalog the runtime saved. */
	async removeProject(projectId: string): Promise<Project[]> {
		return (await this.pilo.removeProject(projectId)) as Project[];
	}

	/** Reads a directory on a non-local connection for the remote browser. */
	async readConnectionDir(
		connectionId: string,
		path?: string,
	): Promise<FsEntry[]> {
		return (await this.pilo.readConnectionDir(
			connectionId,
			path ?? "/",
		)) as FsEntry[];
	}

	/** The host's native folder picker; `null` when dismissed. */
	async pickLocalProjectDirectory(): Promise<string | null> {
		return (await this.pilo.pickLocalProjectDirectory()) as string | null;
	}

	/** The local connection row, created if the catalog does not have it yet. */
	async getLocalConnection(): Promise<Connection> {
		return (await this.pilo.getLocalConnection()) as Connection;
	}

	/** Renames a connection and sets its custom Pi executable path. */
	async updateConnectionSettings(
		id: string,
		name: string,
		piExecutable: string | null,
	): Promise<Connection> {
		return (await this.pilo.updateConnectionSettings(
			id,
			name,
			piExecutable,
		)) as Connection;
	}

	/** Toggles whether a connection shows in the home environment list. */
	async setConnectionShownInHome(
		id: string,
		shown: boolean,
	): Promise<Connection> {
		return (await this.pilo.setConnectionShownInHome(id, shown)) as Connection;
	}

	/** Pings the connection and probes its Pi executable for diagnostics. */
	async getConnectionHealth(id: string): Promise<ConnectionHealth> {
		return (await this.pilo.getConnectionHealth(id)) as ConnectionHealth;
	}

	/** Probes a Pi executable path on a connection without saving it. */
	async probeConnectionPi(
		id: string,
		executable?: string | null,
	): Promise<PiExecutableInfo> {
		return (await this.pilo.probeConnectionPi(
			id,
			executable ?? null,
		)) as PiExecutableInfo;
	}

	/** Pings the local pilo-server connection. */
	async testLocalConnection(): Promise<ConnectionTestResult> {
		return (await this.pilo.testLocalConnection()) as ConnectionTestResult;
	}

	/** The SSH connections in the catalog, with project counts and secret flags. */
	async listSshConnections(): Promise<SshConnectionInfo[]> {
		return (await this.pilo.listSshConnections()) as SshConnectionInfo[];
	}

	/** The SSH agent's public identities, for the connection editor. */
	async listSshAgentIdentities(): Promise<SshAgentIdentity[]> {
		return (await this.pilo.listSshAgentIdentities()) as SshAgentIdentity[];
	}

	/** Saves an SSH connection draft; `password` replaces its stored secret. */
	async saveSshConnection(
		connection: Connection,
		password?: string | null,
		localPiResources?: boolean,
	): Promise<SshConnectionInfo> {
		return (await this.pilo.saveSshConnection({
			connection,
			password: password ?? null,
			localPiResources: localPiResources ?? null,
		})) as SshConnectionInfo;
	}

	/** The stored password of an SSH connection, or null when it has none. */
	async getSshConnectionPassword(id: string): Promise<string | null> {
		return (await this.pilo.getSshConnectionPassword(id)) as string | null;
	}

	/** Removes an SSH connection, stopping its projects first. */
	async removeSshConnection(id: string): Promise<void> {
		await this.pilo.removeSshConnection(id);
	}

	/** Pings a saved SSH connection. */
	async testSshConnection(id: string): Promise<ConnectionTestResult> {
		return (await this.pilo.testSshConnection(id)) as ConnectionTestResult;
	}

	/** Pings an SSH draft before it is saved. */
	async testSshConnectionDraft(
		connection: Connection,
		password?: string | null,
	): Promise<ConnectionTestResult> {
		return (await this.pilo.testSshConnectionDraft(
			connection,
			password ?? null,
		)) as ConnectionTestResult;
	}

	/** The WSL distributions on the host; errors when WSL is unavailable. */
	async listWslDistributions(): Promise<WslDistribution[]> {
		return (await this.pilo.listWslDistributions()) as WslDistribution[];
	}

	/** The WSL connections in the catalog, with project counts. */
	async listWslConnections(): Promise<WslConnectionInfo[]> {
		return (await this.pilo.listWslConnections()) as WslConnectionInfo[];
	}

	/** Saves a WSL connection row. */
	async saveWslConnection(connection: Connection): Promise<WslConnectionInfo> {
		return (await this.pilo.saveWslConnection(connection)) as WslConnectionInfo;
	}

	/** Removes a WSL connection, stopping its projects first. */
	async removeWslConnection(id: string): Promise<void> {
		await this.pilo.removeWslConnection(id);
	}

	/** Pings a WSL distribution before or after saving it as a connection. */
	async testWslConnection(distro: string): Promise<ConnectionTestResult> {
		return (await this.pilo.testWslConnection(distro)) as ConnectionTestResult;
	}

	/**
	 * The project's saved sessions after a scan, or as indexed when `cached`.
	 * With `unwatchedOnly`, the Host scans only when no live session watcher
	 * keeps the index current, and reads the index otherwise.
	 */
	async listSessions(
		projectId: string,
		cached = false,
		unwatchedOnly = false,
	): Promise<SessionIndexEntry[]> {
		return (
			cached
				? await this.pilo.listSessions(projectId, true)
				: unwatchedOnly
					? await this.pilo.listSessions(projectId, false, true)
					: await this.pilo.listSessions(projectId)
		) as SessionIndexEntry[];
	}

	/** The Host's session index as it stands, without a scan. */
	listCachedSessions(projectId: string): Promise<SessionIndexEntry[]> {
		return this.listSessions(projectId, true);
	}

	/** Messages of the project's saved sessions that contain the query. */
	async searchSessions(
		projectId: string,
		query: string,
		limit?: number,
	): Promise<SessionSearchMatch[]> {
		return (await this.pilo.searchSessions(
			projectId,
			query,
			limit,
		)) as SessionSearchMatch[];
	}

	/** Project file paths matching the query, for composer `@` mentions. */
	async searchProjectFiles(
		projectId: string,
		query: string,
	): Promise<string[]> {
		return (await this.pilo.searchProjectFiles(projectId, query)) as string[];
	}

	/** Stores a composer attachment inside the project and returns its path. */
	async uploadChatFile(
		projectId: string,
		name: string,
		data: Uint8Array,
	): Promise<string> {
		return (await this.pilo.uploadChatFile(projectId, name, data)) as string;
	}

	/** Removes a stored composer attachment. */
	async removeChatFile(projectId: string, path: string): Promise<void> {
		await this.pilo.removeChatFile(projectId, path);
	}

	/** A title from the naming model, or null when none is configured. */
	generateSessionTitle(projectId: string, message: string) {
		return this.pilo.generateSessionTitle(projectId, message);
	}

	/**
	 * The project's sessions an external Pi (one this app did not start) runs
	 * a turn in; later changes arrive as `external_session_activity_changed`.
	 */
	async externalSessionActivity(
		projectId: string,
	): Promise<SessionExternalActivity[]> {
		return (await this.pilo.externalSessionActivity(
			projectId,
		)) as SessionExternalActivity[];
	}

	/** Deletes a session that `listSessions` has returned. */
	async deleteSession(
		projectId: string,
		sessionPath: string,
	): Promise<SessionDeleteResult> {
		return (await this.pilo.deleteSession(
			projectId,
			sessionPath,
		)) as SessionDeleteResult;
	}

	/**
	 * Updates an indexed session's pin state or title override; the index
	 * reports the new entry through `sessions_indexed`.
	 */
	async updateSessionUiState(
		sessionPath: string,
		update: SessionUiStateUpdate,
		projectId?: string,
	): Promise<SessionIndexEntry> {
		return (await this.pilo.updateSessionUiState(
			sessionPath,
			update,
			projectId,
		)) as SessionIndexEntry;
	}

	/**
	 * A window of a saved session's history, read from its file without
	 * starting Pi; by default the last 256 messages with the message index.
	 * It is the settled history only: it has no place in the event stream,
	 * so a turn in progress is not in it and events cannot be applied on top.
	 */
	async loadHistory(
		projectId: string,
		sessionPath: string,
		options?: PiloClientHistoryOptions,
	): Promise<SessionHistoryResult> {
		return (await this.pilo.loadHistory(
			projectId,
			sessionPath,
			options,
		)) as SessionHistoryResult;
	}

	/**
	 * The bytes of one image attachment in a session file. A fingerprint from
	 * the history that named the image rejects a file that changed since.
	 */
	async readHistoryImage(
		projectId: string,
		sessionPath: string,
		imageId: string,
		fingerprint?: SessionHistoryFingerprint,
	) {
		return (await this.pilo.readHistoryImage(
			projectId,
			sessionPath,
			imageId,
			fingerprint,
		)) as ImageBytes;
	}

	/** The bytes of an image at a path relative to the project. */
	async readProjectImage(projectId: string, path: string) {
		return (await this.pilo.readProjectImage(projectId, path)) as ImageBytes;
	}

	/** Pi's current user-level model catalog for the connection. */
	async loadConnectionModels(connectionId: string): Promise<PiModel[]> {
		return (await this.pilo.loadConnectionModels(connectionId)) as PiModel[];
	}

	/**
	 * The project's saved model catalog, or null when none is cached. It does
	 * not start Pi or refresh the cache.
	 */
	async loadModels(projectId: string): Promise<ProjectPiModels | null> {
		return (await this.pilo.loadModels(projectId)) as ProjectPiModels | null;
	}

	/** Persists a refreshed catalog snapshot as the project's model cache. */
	async saveModels(snapshot: ProjectPiModels): Promise<ProjectPiModels> {
		return (await this.pilo.saveModels(snapshot)) as ProjectPiModels;
	}

	/** The project's model scope; `models: null` means it inherits Pi's. */
	async loadModelScope(projectId: string): Promise<ProjectModelScope> {
		return (await this.pilo.loadModelScope(projectId)) as ProjectModelScope;
	}

	/**
	 * Replaces the project's model scope with the ordered list, `[]` for an
	 * empty one, or restores inheriting Pi's with `null`. Listeners also get
	 * the new scope as a `project_model_scope_changed` event.
	 */
	async saveModelScope(
		projectId: string,
		models: ProjectScopedModel[] | null,
	): Promise<ProjectModelScope> {
		return (await this.pilo.saveModelScope(
			projectId,
			models,
		)) as ProjectModelScope;
	}

	/** Each connection's saved session-naming model. */
	async loadNamingModels(): Promise<ConnectionNamingModel[]> {
		return (await this.pilo.loadNamingModels()) as ConnectionNamingModel[];
	}

	/** Sets or clears (null, null) a connection's session-naming model. */
	async saveNamingModel(
		connectionId: string,
		provider: string | null,
		modelId: string | null,
	): Promise<ConnectionNamingModel | null> {
		return (await this.pilo.saveNamingModel(
			connectionId,
			provider,
			modelId,
		)) as ConnectionNamingModel | null;
	}

	/** The connection's saved cache keep-alive policies, one per model. */
	async loadCacheKeepAliveSettings(
		connectionId: string,
	): Promise<CacheKeepAliveSettings[]> {
		return (await this.pilo.loadCacheKeepAliveSettings(
			connectionId,
		)) as CacheKeepAliveSettings[];
	}

	/**
	 * Saves one model's policy and returns it with the `updatedAtMs` the Host
	 * assigned. Listeners also get it as `cache_keep_alive_settings_changed`.
	 */
	async saveCacheKeepAliveSettings(
		settings: CacheKeepAliveSettings,
	): Promise<CacheKeepAliveSettings> {
		return (await this.pilo.saveCacheKeepAliveSettings(
			settings,
		)) as CacheKeepAliveSettings;
	}

	/** The connection's next-prompt settings; disabled when never saved. */
	async loadNextPromptSettings(
		connectionId: string,
	): Promise<NextPromptSettings> {
		return (await this.pilo.loadNextPromptSettings(
			connectionId,
		)) as NextPromptSettings;
	}

	/**
	 * Replaces the connection's next-prompt settings; a `null` model follows
	 * the chat's. Listeners also get them as `next_prompt_settings_changed`.
	 */
	async saveNextPromptSettings(
		connectionId: string,
		enabled: boolean,
		model: NextPromptModel | null,
	): Promise<NextPromptSettings> {
		return (await this.pilo.saveNextPromptSettings(
			connectionId,
			enabled,
			model,
		)) as NextPromptSettings;
	}

	/**
	 * Asks a running, idle chat for a next-prompt suggestion, or cancels the
	 * request with the same identity. It resolves once the request is sent;
	 * the suggestion arrives through `connectEvents`.
	 */
	requestNextPrompt(request: NextPromptRequest) {
		return this.pilo.requestNextPrompt(request);
	}

	/** The connection's prompt enhancement settings; disabled when never saved. */
	async loadPromptEnhancementSettings(
		connectionId: string,
	): Promise<PromptEnhancementSettings> {
		return (await this.pilo.loadPromptEnhancementSettings(
			connectionId,
		)) as PromptEnhancementSettings;
	}

	/**
	 * Replaces the connection's prompt enhancement settings; a `null` model
	 * follows the chat's. Listeners also get them as
	 * `prompt_enhancement_settings_changed`.
	 */
	async savePromptEnhancementSettings(
		connectionId: string,
		enabled: boolean,
		model: PromptEnhancementModel | null,
	): Promise<PromptEnhancementSettings> {
		return (await this.pilo.savePromptEnhancementSettings(
			connectionId,
			enabled,
			model,
		)) as PromptEnhancementSettings;
	}

	/**
	 * The draft rewritten by the project's connection, which must have prompt
	 * enhancement enabled. Its saved model is used, else `model` (the
	 * chat's), else Pi's default. The rewrite runs outside the chat: it
	 * neither enters the transcript nor waits behind a running turn.
	 */
	enhancePrompt(
		projectId: string,
		draft: string,
		model: PromptEnhancementModel | null,
	) {
		return this.pilo.enhancePrompt(projectId, draft, model);
	}

	loadSessionReadStates() {
		return this.pilo.loadSessionReadStates();
	}

	markSessionRead(projectId: string, sessionPath: string, revision: number) {
		return this.pilo.markSessionRead(projectId, sessionPath, revision);
	}

	async loadPreferences(): Promise<PreferencesSnapshot> {
		return (await this.pilo.loadPreferences()) as PreferencesSnapshot;
	}

	async savePreferences(
		patch: PreferencePatch,
		initial?: boolean,
	): Promise<PreferencesSnapshot> {
		// Ordinary saves keep the one-argument native call.
		const saved =
			initial === undefined
				? await this.pilo.savePreferences(patch)
				: await this.pilo.savePreferences(patch, initial);
		return saved as PreferencesSnapshot;
	}

	async loadThemeSettings(): Promise<ThemeSettings> {
		return (await this.pilo.loadThemeSettings()) as ThemeSettings;
	}

	async saveThemeSettings(update: ThemeSettingsUpdate): Promise<ThemeSettings> {
		return (await this.pilo.saveThemeSettings(update)) as ThemeSettings;
	}

	/** The installed font families; none when the native side cannot list them. */
	async systemFontFamilies(): Promise<SystemFontFamily[]> {
		const families = await this.pilo.systemFontFamilies?.();
		return (families ?? []) as SystemFontFamily[];
	}

	/** Starts or resumes Pi for the key and resolves once it is ready. */
	async startChat(input: PiloClientStartChatInput): Promise<PiSessionSnapshot> {
		const start = this.pilo.startChat(input);
		if (!input.noSession) return (await start) as PiSessionSnapshot;

		const key = input.sessionKey;
		const pending = this.noSessionStarts.get(key) ?? new Set();
		pending.add(start);
		this.noSessionStarts.set(key, pending);
		try {
			return (await start) as PiSessionSnapshot;
		} finally {
			pending.delete(start);
			if (pending.size === 0) this.noSessionStarts.delete(key);
		}
	}

	/** Stops Pi for the key; a session that is not running is left alone. */
	async stopChat(sessionKey: string, reason?: string) {
		const pending = this.noSessionStarts.get(sessionKey);
		if (reason === "temporary_chat_left" && pending) {
			// The Host may not have registered Pi yet. Both sending and changing
			// the run configuration can have a start in flight for this key.
			await Promise.allSettled(pending);
		}
		return this.pilo.stopChat(sessionKey, reason);
	}

	/** Live runtime state for the key, without transcript text. */
	async chatState(sessionKey: string): Promise<ChatSessionRuntimeState | null> {
		return (await this.pilo.chatState(
			sessionKey,
		)) as ChatSessionRuntimeState | null;
	}

	/**
	 * The transcript of a started chat, without starting Pi. Connect to the
	 * events before calling, so that those above the snapshot's
	 * `eventSequence` can be applied on top of it. Without a window it reads
	 * the whole saved history.
	 */
	async chatTranscriptSnapshot(
		sessionKey: string,
		window?: ChatTranscriptWindow,
	): Promise<ChatTranscriptSnapshot> {
		return (await this.pilo.chatTranscriptSnapshot(
			sessionKey,
			window,
		)) as ChatTranscriptSnapshot;
	}

	/**
	 * Resolves once the Pi RPC command is sent. Its response and the turn's
	 * events arrive through `connectEvents`.
	 */
	sendChatCommand(sessionKey: string, command: Record<string, unknown>) {
		return this.pilo.sendChatCommand(sessionKey, command);
	}

	/** The Remote Host's live state: enabled/running, addresses, pairing, devices. */
	async remoteHostState(): Promise<RemoteHostState> {
		return (await this.pilo.remoteHostState()) as RemoteHostState;
	}

	/** The machine's LAN IPs for the Remote Host address picker. */
	async remoteLanAddresses(): Promise<string[]> {
		return (await this.pilo.remoteLanAddresses()) as string[];
	}

	/** Enables or disables the Remote Host; resolves with the live state. */
	async remoteSetEnabled(enabled: boolean): Promise<RemoteHostState> {
		return (await this.pilo.remoteSetEnabled(enabled)) as RemoteHostState;
	}

	/** Sets the Remote Host's listen port; resolves with the live state. */
	async remoteSetPort(port: number): Promise<RemoteHostState> {
		return (await this.pilo.remoteSetPort(port)) as RemoteHostState;
	}

	/** Sets the Remote Host's public base URL; resolves with the live state. */
	async remoteSetPublicBaseUrl(url: string): Promise<RemoteHostState> {
		return (await this.pilo.remoteSetPublicBaseUrl(url)) as RemoteHostState;
	}

	/** Replaces the access addresses and entry selection; resolves with the live state. */
	async remoteSetAddresses(
		addresses: RemoteAccessAddress[],
		entryAddressId: string,
	): Promise<RemoteHostState> {
		return (await this.pilo.remoteSetAddresses(
			addresses,
			entryAddressId,
		)) as RemoteHostState;
	}

	/** Regenerates the pairing link; resolves with the live state. */
	async remotePairingRegenerate(): Promise<RemoteHostState> {
		return (await this.pilo.remotePairingRegenerate()) as RemoteHostState;
	}

	/** Revokes a paired device; resolves with the live state. */
	async remoteDeviceRevoke(deviceId: string): Promise<RemoteHostState> {
		return (await this.pilo.remoteDeviceRevoke(deviceId)) as RemoteHostState;
	}

	/** Renames a paired device; resolves with the live state. */
	async remoteDeviceRename(
		deviceId: string,
		name: string,
	): Promise<RemoteHostState> {
		return (await this.pilo.remoteDeviceRename(
			deviceId,
			name,
		)) as RemoteHostState;
	}

	/** Opens the app's log directory in the file manager. */
	openLogDirectory() {
		return this.pilo.openLogDirectory(process.logFile);
	}

	/** Opens a shell in the project; its output comes from `nextTerminalEvents`. */
	async openTerminal(
		projectId: string,
		cols: number,
		rows: number,
	): Promise<TerminalInfo> {
		if (!this.pilo.openTerminal) throw unavailable("openTerminal");
		return (await this.pilo.openTerminal(
			projectId,
			cols,
			rows,
		)) as TerminalInfo;
	}

	async writeTerminal(terminalId: string, data: Uint8Array): Promise<void> {
		if (!this.pilo.writeTerminal) throw unavailable("writeTerminal");
		await this.pilo.writeTerminal(terminalId, data);
	}

	async resizeTerminal(
		terminalId: string,
		cols: number,
		rows: number,
	): Promise<void> {
		if (!this.pilo.resizeTerminal) throw unavailable("resizeTerminal");
		await this.pilo.resizeTerminal(terminalId, cols, rows);
	}

	/** Closes the terminal and its shell; an absent one is already closed. */
	async closeTerminal(terminalId: string): Promise<void> {
		if (!this.pilo.closeTerminal) throw unavailable("closeTerminal");
		await this.pilo.closeTerminal(terminalId);
	}

	/** Waits for the next terminal events, in order. */
	async nextTerminalEvents(max: number): Promise<TerminalEvent[]> {
		if (!this.pilo.nextTerminalEvents) throw unavailable("nextTerminalEvents");
		return (await this.pilo.nextTerminalEvents(max)) as TerminalEvent[];
	}

	/** Whether the runtime shut down: its event stream never resumes. */
	get closed() {
		return this.streamClosed;
	}

	/**
	 * Delivers runtime events in sequence order, starting with those queued
	 * since the native module was created. A listener can therefore receive
	 * events at or below the `latestSequence` of its own bootstrap: state that
	 * the bootstrap snapshot already holds skips them, but chat deltas are not
	 * dropped by that sequence (see `desktop/README.md`). The module has no
	 * replay cursor, so `after` is not honored: a `resyncRequired` message
	 * names the last sequence the queue dropped, and the listener bootstraps
	 * again. `onStatus(false)` follows a runtime shutdown or a failed poll;
	 * connecting again resumes a failed stream.
	 */
	connectEvents(options: PiloClientEventOptions): Promise<() => void> {
		if (this.streamClosed) {
			options.onStatus(false);
			return Promise.resolve(() => {});
		}
		this.listeners.add(options);
		options.onStatus(true);
		void this.poll();
		return Promise.resolve(() => {
			if (this.listeners.delete(options)) options.onStatus(false);
		});
	}

	/** Await before the app quits; later calls reject. */
	shutdown() {
		return this.pilo.shutdown();
	}

	/** Keeps one native poll in flight while anyone listens. */
	private async poll() {
		if (this.polling) return;
		this.polling = true;
		try {
			while (this.listeners.size > 0) {
				const batch =
					this.held ??
					((await this.pilo.nextEvents(EVENT_BATCH_SIZE)) as NativeEventBatch);
				this.held = undefined;
				if (batch.type === "closed") {
					this.streamClosed = true;
					break;
				}
				if (this.listeners.size === 0) {
					this.held = batch;
					break;
				}
				this.publish(
					batch.type === "gap"
						? { type: "resyncRequired", latestSequence: batch.lastMissed }
						: batch,
				);
			}
		} catch (error) {
			console.error("Pilo event polling failed", error);
		}
		this.polling = false;
		this.disconnect();
	}

	private publish(message: PiloClientEventMessage) {
		for (const listener of [...this.listeners]) {
			notify(() => listener.onMessage(message));
		}
	}

	private disconnect() {
		const listeners = [...this.listeners];
		this.listeners.clear();
		for (const listener of listeners) {
			notify(() => listener.onStatus(false));
		}
	}
}

/** A native call a stand-in left out. */
function unavailable(name: string) {
	return new Error(`The native call ${name} is unavailable`);
}

/** One listener that throws must not stop the stream for the others. */
function notify(call: () => void) {
	try {
		call();
	} catch (error) {
		console.error("Pilo event listener failed", error);
	}
}
