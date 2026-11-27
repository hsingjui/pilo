import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";
import type {
	ConnectionHealth,
	ConnectionTestResult,
	PiExecutableInfo,
	SshAgentIdentity,
	SshConfigHost,
	SshConnectionInfo,
	WslConnectionInfo,
} from "@shared/api/connections-types";
import type { FsEntry } from "@shared/api/files-types";
import type { GitStatus } from "@shared/api/git-types";
import type {
	ChatTranscriptSnapshot,
	ChatTranscriptWindow,
	HostApiMethodName,
	HostApiMethods,
	HostBootstrap,
	TerminalEvent,
	TerminalInfo,
	TerminalSnapshot,
} from "@shared/api/host-methods";
import type {
	HostCallOptions,
	HostCapabilities,
	HostEventStream,
	HostTransport,
} from "@shared/api/host-transport";
import type { ProjectPiModels } from "@shared/api/pi-models-types";
import type {
	Connection,
	PiModel,
	PiSessionSnapshot,
	WslDistribution,
} from "@shared/api/pi-runtime-types";
import type {
	PiloClient,
	PiloClientEventOptions,
	PiloClientHistoryOptions,
	PiloClientStartChatInput,
} from "@shared/api/pilo-client";
import type { Project } from "@shared/api/projects-types";
import type {
	RemoteAccessAddress,
	RemoteHostState,
	RemoteScopes,
} from "@shared/api/remote-types";
import type {
	ConnectionNamingModel,
	SessionDeleteResult,
	SessionExternalActivity,
	SessionHistoryFingerprint,
	SessionHistoryResult,
	SessionIndexEntry,
	SessionSearchMatch,
	SessionUiStateUpdate,
} from "@shared/api/sessions-types";
import type { CacheKeepAliveSettings } from "@shared/cache-keep-alive";
import type {
	PreferencePatch,
	PreferencesSnapshot,
} from "@shared/host-preferences-types";
import type {
	NextPromptModel,
	NextPromptRequest,
	NextPromptSettings,
} from "@shared/next-prompt-types";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@shared/project-model-scope";
import type { WorkspaceFile } from "@shared/project-workspace";
import type {
	PromptEnhancementModel,
	PromptEnhancementSettings,
} from "@shared/prompt-enhancement-types";
import type { SessionReadState } from "@shared/session-read-state";
import { randomId } from "@shared/random-id";
import type {
	ThemeSettings,
	ThemeSettingsUpdate,
} from "@shared/theme-settings-types";

/**
 * Strongly-typed client for every Host API method over any `HostTransport`
 * (`NativeTransport` for the embedded desktop Host, `HttpTransport` for remote
 * Hosts over Gateway v2).
 */
export class HostClient implements PiloClient {
	private readonly transport: HostTransport;
	private readonly noSessionStarts = new Map<string, Set<Promise<unknown>>>();
	private isShutdown = false;
	readonly rpcIdPrefix = `nsh-rpc-${randomId()}`;

	constructor(transport: HostTransport) {
		this.transport = transport;
	}

	get closed(): boolean {
		return this.isShutdown || Boolean(this.transport.closed);
	}

	get capabilities(): HostCapabilities | null {
		return this.transport.capabilities ?? null;
	}

	get reconnectsEvents(): boolean {
		return this.transport.reconnectsEvents ?? false;
	}

	hasMethod(name: HostApiMethodName): boolean {
		const methods = this.transport.capabilities?.methods;
		if (!methods) return true;
		return methods.includes(name);
	}

	eventStream(): HostEventStream {
		return this.transport.events();
	}

	call<M extends HostApiMethodName>(
		method: M,
		params: HostApiMethods[M]["params"],
		opts?: HostCallOptions,
	): Promise<HostApiMethods[M]["result"]> {
		return this.transport.call<HostApiMethods[M]["result"]>(
			method,
			params,
			opts,
		);
	}

	async bootstrap(): Promise<HostBootstrap> {
		const snapshot = await this.call("host.bootstrap", {
			includePreferences: true,
		});
		return {
			projects: snapshot.projects,
			chatSessions: snapshot.chatSessions,
			latestSequence: snapshot.latestSequence ?? snapshot.eventSequence,
			preferences: snapshot.preferences,
			localPiResources: snapshot.localPiResources,
		};
	}

	listProjects(): Promise<Project[]> {
		return this.call("project.list", {});
	}

	addProject(connectionId: string, path: string): Promise<Project> {
		return this.call("project.add", { connectionId, path });
	}

	removeProject(projectId: string): Promise<Project[]> {
		return this.call("project.remove", { projectId });
	}

	listConnections(): Promise<Connection[]> {
		return this.call("connection.list", {});
	}

	readConnectionDir(connectionId: string, path = ""): Promise<FsEntry[]> {
		return this.call("connection.readDir", { connectionId, path });
	}

	getLocalConnection(): Promise<Connection> {
		return this.call("connection.local.get", {});
	}

	updateConnectionSettings(
		id: string,
		name: string,
		piExecutable: string | null,
	): Promise<Connection> {
		return this.call("connection.settings.update", {
			id,
			name,
			piExecutable,
		});
	}

	setConnectionShownInHome(id: string, shown: boolean): Promise<Connection> {
		return this.call("connection.shownInHome.set", { id, shown });
	}

	getConnectionHealth(id: string): Promise<ConnectionHealth> {
		return this.call("connection.health", { id });
	}

	probeConnectionPi(
		id: string,
		executable?: string | null,
	): Promise<PiExecutableInfo> {
		return this.call("connection.pi.probe", {
			id,
			executable: executable ?? null,
		});
	}

	testLocalConnection(): Promise<ConnectionTestResult> {
		return this.call("connection.local.test", {});
	}

	setConnectionLocalPiResources(
		connectionId: string,
		enabled: boolean,
	): Promise<void> {
		return this.call("connection.localPiResources.set", {
			connectionId,
			enabled,
		});
	}

	listSshConnections(): Promise<SshConnectionInfo[]> {
		return this.call("connection.ssh.list", {});
	}

	listSshAgentIdentities(): Promise<SshAgentIdentity[]> {
		return this.call("connection.ssh.agentIdentities", {});
	}

	listSshConfigHosts(): Promise<SshConfigHost[]> {
		return this.call("connection.ssh.configHosts", {});
	}

	listSshLocalKeys(): Promise<string[]> {
		return this.call("connection.ssh.localKeys", {});
	}

	saveSshConnection(
		connection: Connection,
		password?: string | null,
		localPiResources?: boolean,
	): Promise<SshConnectionInfo> {
		return this.call("connection.ssh.save", {
			request: {
				connection,
				password,
				localPiResources,
			},
		});
	}

	getSshConnectionPassword(id: string): Promise<string | null> {
		return this.call("connection.ssh.password", { id });
	}

	removeSshConnection(id: string): Promise<void> {
		return this.call("connection.ssh.remove", { id });
	}

	testSshConnection(id: string): Promise<ConnectionTestResult> {
		return this.call("connection.ssh.test", { id });
	}

	testSshConnectionDraft(
		connection: Connection,
		password?: string | null,
	): Promise<ConnectionTestResult> {
		return this.call("connection.ssh.testDraft", {
			connection,
			password: password ?? null,
		});
	}

	listWslDistributions(): Promise<WslDistribution[]> {
		return this.call("connection.wsl.distributions", {});
	}

	listWslConnections(): Promise<WslConnectionInfo[]> {
		return this.call("connection.wsl.list", {});
	}

	saveWslConnection(connection: Connection): Promise<WslConnectionInfo> {
		return this.call("connection.wsl.save", { connection });
	}

	removeWslConnection(id: string): Promise<void> {
		return this.call("connection.wsl.remove", { id });
	}

	testWslConnection(distro: string): Promise<ConnectionTestResult> {
		return this.call("connection.wsl.test", { distro });
	}

	listSessions(
		projectId: string,
		cached = false,
		unwatchedOnly = false,
	): Promise<SessionIndexEntry[]> {
		return this.call("session.list", { projectId, cached, unwatchedOnly });
	}

	listCachedSessions(projectId: string): Promise<SessionIndexEntry[]> {
		return this.call("session.list", {
			projectId,
			cached: true,
			unwatchedOnly: false,
		});
	}

	searchSessions(
		projectId: string,
		query: string,
		limit = 24,
	): Promise<SessionSearchMatch[]> {
		return this.call("session.search", { projectId, query, limit });
	}

	searchProjectFiles(projectId: string, query: string): Promise<string[]> {
		return this.call("files.search", { projectId, query });
	}

	previewFileLink(
		projectId: string,
		url: string,
	): Promise<WorkspaceFile | null> {
		return this.call("project.file.preview", { projectId, url });
	}

	uploadChatFile(
		projectId: string,
		name: string,
		data: Uint8Array,
	): Promise<string> {
		return this.transport.upload<string>(
			"chat.files.upload",
			{ projectId, name },
			data,
		);
	}

	removeChatFile(projectId: string, path: string): Promise<void> {
		return this.call("chat.files.remove", { projectId, path });
	}

	generateSessionTitle(
		projectId: string,
		message: string,
	): Promise<string | null> {
		return this.call("session.title", { projectId, message });
	}

	deleteSession(
		projectId: string,
		sessionPath: string,
	): Promise<SessionDeleteResult> {
		return this.call("session.delete", { projectId, sessionPath });
	}

	archiveSession(
		projectId: string,
		sessionPath: string,
	): Promise<SessionIndexEntry> {
		return this.updateSessionUiState(
			sessionPath,
			{ archived: true },
			projectId,
		);
	}

	unarchiveSession(
		projectId: string,
		sessionPath: string,
	): Promise<SessionIndexEntry> {
		return this.updateSessionUiState(
			sessionPath,
			{ archived: false },
			projectId,
		);
	}

	externalSessionActivity(
		projectId: string,
	): Promise<SessionExternalActivity[]> {
		return this.call("session.externalActivity", { projectId });
	}

	updateSessionUiState(
		sessionPath: string,
		update: SessionUiStateUpdate,
		projectId?: string,
	): Promise<SessionIndexEntry> {
		return this.call("session.uiState.set", {
			projectId,
			sessionPath,
			update,
		});
	}

	loadHistory(
		projectId: string,
		sessionPath: string,
		options?: PiloClientHistoryOptions,
	): Promise<SessionHistoryResult> {
		return this.call("session.history", {
			projectId,
			sessionPath,
			expectedFileSize: options?.fingerprint?.fileSize,
			expectedFileMtimeNs: options?.fingerprint?.fileMtimeNs,
			startMessage: options?.startMessage,
			messageLimit: options?.messageLimit,
			includeMessageIndex: options?.includeMessageIndex,
		});
	}

	readHistoryImage(
		projectId: string,
		sessionPath: string,
		imageId: string,
		fingerprint?: SessionHistoryFingerprint,
	): Promise<Uint8Array<ArrayBuffer>> {
		const params: Record<string, string> = {
			projectId,
			sessionPath,
			imageId,
		};
		if (fingerprint) {
			params.expectedFileSize = String(fingerprint.fileSize);
			params.expectedFileMtimeNs = fingerprint.fileMtimeNs;
		}
		return this.transport.download("session.historyImage", params);
	}

	readProjectImage(
		projectId: string,
		path: string,
	): Promise<Uint8Array<ArrayBuffer>> {
		return this.transport.download("files.image", { projectId, path });
	}

	loadConnectionModels(connectionId: string): Promise<PiModel[]> {
		return this.call("connection.models", { connectionId });
	}

	loadModels(projectId: string): Promise<ProjectPiModels | null> {
		return this.call("models.get", { projectId });
	}

	saveModels(snapshot: ProjectPiModels): Promise<ProjectPiModels> {
		return this.call("models.set", { cache: snapshot });
	}

	loadModelScope(projectId: string): Promise<ProjectModelScope> {
		return this.call("models.scope.get", { projectId });
	}

	saveModelScope(
		projectId: string,
		models: ProjectScopedModel[] | null,
	): Promise<ProjectModelScope> {
		return this.call("models.scope.set", { projectId, models });
	}

	loadNamingModels(): Promise<ConnectionNamingModel[]> {
		return this.call("connection.namingModels.list", {});
	}

	saveNamingModel(
		connectionId: string,
		provider: string | null,
		modelId: string | null,
	): Promise<ConnectionNamingModel | null> {
		return this.call("connection.namingModels.set", {
			connectionId,
			provider,
			modelId,
		});
	}

	loadCacheKeepAliveSettings(
		connectionId: string,
	): Promise<CacheKeepAliveSettings[]> {
		return this.call("cacheKeepAlive.settings.list", { connectionId });
	}

	saveCacheKeepAliveSettings(
		settings: CacheKeepAliveSettings,
	): Promise<CacheKeepAliveSettings> {
		return this.call("cacheKeepAlive.settings.set", { settings });
	}

	pauseCacheKeepAlive(sessionKey: string): Promise<void> {
		return this.call("cacheKeepAlive.pause", { sessionKey });
	}

	loadNextPromptSettings(connectionId: string): Promise<NextPromptSettings> {
		return this.call("nextPrompt.settings.get", { connectionId });
	}

	saveNextPromptSettings(
		connectionId: string,
		enabled: boolean,
		model: NextPromptModel | null,
	): Promise<NextPromptSettings> {
		return this.call("nextPrompt.settings.set", {
			connectionId,
			enabled,
			model,
		});
	}

	requestNextPrompt(request: NextPromptRequest): Promise<void> {
		return this.call("nextPrompt.request", { request });
	}

	loadPromptEnhancementSettings(
		connectionId: string,
	): Promise<PromptEnhancementSettings> {
		return this.call("promptEnhancement.settings.get", { connectionId });
	}

	savePromptEnhancementSettings(
		connectionId: string,
		enabled: boolean,
		model: PromptEnhancementModel | null,
	): Promise<PromptEnhancementSettings> {
		return this.call("promptEnhancement.settings.set", {
			connectionId,
			enabled,
			model,
		});
	}

	enhancePrompt(
		projectId: string,
		draft: string,
		model: PromptEnhancementModel | null,
	): Promise<string> {
		return this.call("promptEnhancement.enhance", {
			projectId,
			draft,
			model,
		});
	}

	loadSessionReadStates(): Promise<SessionReadState[]> {
		return this.call("session.readStates", {});
	}

	markSessionRead(
		projectId: string,
		sessionPath: string,
		revision: number,
	): Promise<SessionReadState> {
		if (!Number.isSafeInteger(revision) || revision <= 0) {
			return Promise.reject(
				new Error("session read revision must be a positive safe integer"),
			);
		}
		return this.call("session.markRead", {
			projectId,
			sessionPath,
			revision,
		});
	}

	loadPreferences(): Promise<PreferencesSnapshot> {
		return this.call("preferences.get", {});
	}

	savePreferences(
		patch: PreferencePatch,
		initial = false,
	): Promise<PreferencesSnapshot> {
		return this.call("preferences.patch", { patch, initial });
	}

	loadThemeSettings(): Promise<ThemeSettings> {
		return this.call("theme.get", {});
	}

	saveThemeSettings(update: ThemeSettingsUpdate): Promise<ThemeSettings> {
		return this.call("theme.set", { update });
	}

	async startChat(input: PiloClientStartChatInput): Promise<PiSessionSnapshot> {
		const start = this.call("chat.start", input);
		if (!input.noSession) return await start;

		const key = input.sessionKey;
		let pending = this.noSessionStarts.get(key);
		if (!pending) {
			pending = new Set();
			this.noSessionStarts.set(key, pending);
		}
		pending.add(start);
		try {
			return await start;
		} finally {
			pending.delete(start);
			if (pending.size === 0) {
				this.noSessionStarts.delete(key);
			}
		}
	}

	async stopChat(sessionKey: string, reason?: string): Promise<void> {
		const pending = this.noSessionStarts.get(sessionKey);
		if (reason === "temporary_chat_left" && pending) {
			await Promise.allSettled(pending);
		}
		await this.call("chat.stop", { sessionKey, reason });
	}

	chatState(sessionKey: string): Promise<ChatSessionRuntimeState | null> {
		return this.call("chat.state", { sessionKey });
	}

	chatTranscriptSnapshot(
		sessionKey: string,
		window?: ChatTranscriptWindow,
	): Promise<ChatTranscriptSnapshot> {
		return this.call("chat.transcript", { sessionKey, window });
	}

	sendChatCommand(
		sessionKey: string,
		command: Record<string, unknown>,
	): Promise<void> {
		return this.call("chat.rpc", { sessionKey, command });
	}

	approveProjectMcpServer(
		projectId: string,
		serverName: string,
	): Promise<void> {
		return this.call("chat.mcp.approve", { projectId, serverName });
	}

	remoteHostState(): Promise<RemoteHostState> {
		return this.call("remote.state", {});
	}

	remoteLanAddresses(): Promise<string[]> {
		return this.call("remote.lanAddresses", {});
	}

	remoteSetEnabled(enabled: boolean): Promise<RemoteHostState> {
		return this.call("remote.enabled.set", { enabled });
	}

	remoteSetPort(port: number): Promise<RemoteHostState> {
		return this.call("remote.port.set", { port });
	}

	remoteSetAddresses(
		addresses: RemoteAccessAddress[],
		entryAddressId: string,
	): Promise<RemoteHostState> {
		return this.call("remote.addresses.set", { addresses, entryAddressId });
	}

	remotePairingRegenerate(scopes: RemoteScopes): Promise<RemoteHostState> {
		return this.call("remote.pairing.regenerate", { scopes });
	}

	remoteDeviceRevoke(deviceId: string): Promise<RemoteHostState> {
		return this.call("remote.device.revoke", { deviceId });
	}

	remoteDevicesRevokeAll(): Promise<RemoteHostState> {
		return this.call("remote.devices.revokeAll", {});
	}

	remoteDeviceSetScopes(
		deviceId: string,
		scopes: RemoteScopes,
	): Promise<RemoteHostState> {
		return this.call("remote.devices.setScopes", { deviceId, scopes });
	}

	remoteDeviceRename(deviceId: string, name: string): Promise<RemoteHostState> {
		return this.call("remote.device.rename", { deviceId, name });
	}

	revokeSelf(): Promise<void> {
		return this.call("device.revokeSelf", {});
	}

	getProjectGitStatus(projectId: string): Promise<GitStatus> {
		return this.call("git.status", { projectId });
	}

	getProjectGitDiff(
		projectId: string,
		options: { path?: string; staged: boolean },
	): Promise<string> {
		return this.call("git.diff", {
			projectId,
			path: options.path,
			staged: options.staged,
		});
	}

	openTerminal(
		projectId: string,
		cols: number,
		rows: number,
	): Promise<TerminalInfo> {
		return this.call("terminal.open", { projectId, cols, rows });
	}

	async writeTerminal(terminalId: string, data: Uint8Array): Promise<void> {
		await this.transport.upload("terminal.write", { terminalId }, data);
	}

	resizeTerminal(
		terminalId: string,
		cols: number,
		rows: number,
	): Promise<void> {
		return this.call("terminal.resize", { terminalId, cols, rows });
	}

	closeTerminal(terminalId: string): Promise<void> {
		return this.call("terminal.close", { terminalId });
	}

	attachTerminal(terminalId: string): Promise<TerminalInfo> {
		return this.call("terminal.attach", { terminalId });
	}

	snapshotTerminal(terminalId: string): Promise<TerminalSnapshot> {
		return this.call("terminal.snapshot", { terminalId });
	}

	subscribeTerminal(
		terminalId: string,
		listener: (event: TerminalEvent) => void,
	): () => void {
		return this.transport.events().subscribeTerminal(terminalId, listener);
	}

	nextTerminalEvents(max: number): Promise<TerminalEvent[]> {
		const stream = this.transport.events();
		if (stream.nextTerminalEvents) {
			return stream.nextTerminalEvents(max);
		}
		return Promise.resolve([]);
	}

	connectEvents(options: PiloClientEventOptions): Promise<() => void> {
		return Promise.resolve(this.transport.events().subscribeEvents(options));
	}

	async shutdown(): Promise<void> {
		if (this.isShutdown) return;
		this.isShutdown = true;
		try {
			await this.transport.call("host.shutdown", {});
		} finally {
			this.transport.dispose();
		}
	}

	dispose(): void {
		this.isShutdown = true;
		this.transport.dispose();
	}
}
