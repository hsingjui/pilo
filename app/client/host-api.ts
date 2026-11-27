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
import type { ProjectPiModels } from "@shared/api/pi-models-types";
import type {
	Connection,
	PiloRuntimeEvent,
	WslDistribution,
} from "@shared/api/pi-runtime-types";
import type {
	PiloClient,
	PiloClientBootstrap,
	PiloClientHistoryOptions,
} from "@shared/api/pilo-client";
import type { Project } from "@shared/api/projects-types";
import type {
	RemoteAccessAddress,
	RemoteHostState,
	RemoteScopes,
} from "@shared/api/remote-types";
import type {
	ConnectionNamingModel,
	SessionExternalActivity,
	SessionHistoryResult,
	SessionIndexEntry,
	SessionUiStateUpdate,
} from "@shared/api/sessions-types";
import type {
	PreferencePatch,
	PreferencesSnapshot,
} from "@shared/host-preferences-types";
import type { WorkspaceFile } from "@shared/project-workspace";

/** A shell the runtime runs in a project's environment. */
export type TerminalInfo = { id: string; projectId: string; title: string };

/** What a terminal reports; `output` carries base64 bytes. */
export type TerminalEvent =
	| { type: "output"; terminalId: string; data: string }
	| { type: "exit"; terminalId: string }
	| { type: "error"; terminalId: string; message: string };

export type DesktopHostBootstrap = PiloClientBootstrap & {
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
	/** Host timestamp of the reply segment active at this cut. */
	liveStartedAtMs?: number;
	/** Monotonic duration of that segment when the Host returned the cut. */
	liveElapsedMs?: number;
	/** Images indexed by the zero-based ordinal of user starts in this live cut. */
	liveUserImages?: {
		userIndex: number;
		images: NonNullable<
			Extract<PiloRuntimeEvent, { type: "user_message_start" }>["images"]
		>;
	}[];
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

export interface DesktopHostClient extends PiloClient {
	bootstrap(): Promise<DesktopHostBootstrap>;
	listProjects(): Promise<Project[]>;
	listConnections(): Promise<Connection[]>;
	addProject(connectionId: string, path: string): Promise<Project>;
	removeProject(projectId: string): Promise<Project[]>;
	readConnectionDir(connectionId: string, path?: string): Promise<FsEntry[]>;
	getLocalConnection(): Promise<Connection>;
	updateConnectionSettings(
		id: string,
		name: string,
		piExecutable: string | null,
	): Promise<Connection>;
	setConnectionShownInHome(id: string, shown: boolean): Promise<Connection>;
	getConnectionHealth(id: string): Promise<ConnectionHealth>;
	probeConnectionPi(
		id: string,
		executable?: string | null,
	): Promise<PiExecutableInfo>;
	testLocalConnection(): Promise<ConnectionTestResult>;
	listSshConnections(): Promise<SshConnectionInfo[]>;
	listSshAgentIdentities(): Promise<SshAgentIdentity[]>;
	listSshConfigHosts(): Promise<SshConfigHost[]>;
	listSshLocalKeys(): Promise<string[]>;
	saveSshConnection(
		connection: Connection,
		password?: string | null,
		localPiResources?: boolean,
	): Promise<SshConnectionInfo>;
	getSshConnectionPassword(id: string): Promise<string | null>;
	removeSshConnection(id: string): Promise<void>;
	testSshConnection(id: string): Promise<ConnectionTestResult>;
	testSshConnectionDraft(
		connection: Connection,
		password?: string | null,
	): Promise<ConnectionTestResult>;
	listWslDistributions(): Promise<WslDistribution[]>;
	listWslConnections(): Promise<WslConnectionInfo[]>;
	saveWslConnection(connection: Connection): Promise<WslConnectionInfo>;
	removeWslConnection(id: string): Promise<void>;
	testWslConnection(distro: string): Promise<ConnectionTestResult>;
	listSessions(
		projectId: string,
		cached?: boolean,
		unwatchedOnly?: boolean,
	): Promise<SessionIndexEntry[]>;
	searchProjectFiles(projectId: string, query: string): Promise<string[]>;
	previewFileLink(
		projectId: string,
		url: string,
	): Promise<WorkspaceFile | null>;
	uploadChatFile(
		projectId: string,
		name: string,
		data: Uint8Array,
	): Promise<string>;
	removeChatFile(projectId: string, path: string): Promise<void>;
	externalSessionActivity(
		projectId: string,
	): Promise<SessionExternalActivity[]>;
	updateSessionUiState(
		sessionPath: string,
		update: SessionUiStateUpdate,
		projectId?: string,
	): Promise<SessionIndexEntry>;
	saveModels(snapshot: ProjectPiModels): Promise<ProjectPiModels>;
	loadNamingModels(): Promise<ConnectionNamingModel[]>;
	saveNamingModel(
		connectionId: string,
		provider: string | null,
		modelId: string | null,
	): Promise<ConnectionNamingModel | null>;
	pauseCacheKeepAlive(sessionKey: string): Promise<void>;
	savePreferences(
		patch: PreferencePatch,
		initial?: boolean,
	): Promise<PreferencesSnapshot>;
	chatTranscriptSnapshot(
		sessionKey: string,
		window?: ChatTranscriptWindow,
	): Promise<ChatTranscriptSnapshot>;
	remoteHostState(): Promise<RemoteHostState>;
	remoteLanAddresses(): Promise<string[]>;
	remoteSetEnabled(enabled: boolean): Promise<RemoteHostState>;
	remoteSetPort(port: number): Promise<RemoteHostState>;
	remoteSetAddresses(
		addresses: RemoteAccessAddress[],
		entryAddressId: string,
	): Promise<RemoteHostState>;
	remotePairingRegenerate(scopes: RemoteScopes): Promise<RemoteHostState>;
	remoteDeviceRevoke(deviceId: string): Promise<RemoteHostState>;
	remoteDevicesRevokeAll(): Promise<RemoteHostState>;
	remoteDeviceSetScopes(
		deviceId: string,
		scopes: RemoteScopes,
	): Promise<RemoteHostState>;
	remoteDeviceRename(deviceId: string, name: string): Promise<RemoteHostState>;
	getProjectGitStatus(projectId: string): Promise<GitStatus>;
	getProjectGitDiff(
		projectId: string,
		options: { path?: string; staged: boolean },
	): Promise<string>;
	openTerminal(
		projectId: string,
		cols: number,
		rows: number,
	): Promise<TerminalInfo>;
	writeTerminal(terminalId: string, data: Uint8Array): Promise<void>;
	resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
	closeTerminal(terminalId: string): Promise<void>;
	nextTerminalEvents(max: number): Promise<TerminalEvent[]>;
	readonly closed: boolean;
	shutdown(): Promise<void>;
}
