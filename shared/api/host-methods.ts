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
import type { ProjectPiModels } from "@shared/api/pi-models-types";
import type {
	Connection,
	PiModel,
	PiSessionSnapshot,
	PiloRuntimeEvent,
	WslDistribution,
} from "@shared/api/pi-runtime-types";
import type {
	PiloClientBootstrap,
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
import type {
	ThemeSettings,
	ThemeSettingsUpdate,
} from "@shared/theme-settings-types";

export const HOST_API_PROTOCOL_VERSION = "2.0";

export type HostApiScope = "chat" | "workspace" | "admin";
export type HostApiMethodKind = "json" | "binary_in" | "binary_out";

export type HostApiMethodSpec = {
	name: string;
	scope: HostApiScope;
	kind: HostApiMethodKind;
	maxRequestBytes: number;
	maxBinaryInputBytes: number | null;
	timeoutMs: number;
};

export type HostApiErrorCode =
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "invalid_params"
	| "unavailable"
	| "timeout"
	| "internal"
	| "conflict"
	| "outcome_unknown";

export type HostApiErrorPayload = {
	code: HostApiErrorCode;
	message: string;
	retryable: boolean;
};

export class HostApiError extends Error {
	readonly code: HostApiErrorCode;
	readonly retryable: boolean;

	constructor(code: HostApiErrorCode, message: string, retryable = false) {
		super(message);
		this.name = "HostApiError";
		this.code = code;
		this.retryable = retryable;
	}

	static fromPayload(payload: HostApiErrorPayload): HostApiError {
		return new HostApiError(payload.code, payload.message, payload.retryable);
	}
}

/** A shell the runtime runs in a project's environment. */
export type TerminalInfo = { id: string; projectId: string; title: string };

/** What a terminal reports; `output` carries base64 bytes. */
export type TerminalEvent =
	| { type: "output"; terminalId: string; data: string; startOffset?: number }
	| { type: "exit"; terminalId: string }
	| { type: "error"; terminalId: string; message: string };

/** Recent buffered output for a reattached terminal (base64 bytes, up to 64 KiB). */
export type TerminalSnapshot = {
	terminalId: string;
	data: string;
	endOffset?: number;
};

export type HostBootstrapWire = {
	eventSequence: number;
	latestSequence?: number;
	projects: Project[];
	chatSessions: ChatSessionRuntimeState[];
	preferences: PreferencesSnapshot;
	localPiResources?: Record<string, boolean>;
};

export type HostBootstrap = PiloClientBootstrap & {
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
		| { type: "active"; events: PiloRuntimeEvent[] }
		| { type: "truncated" };
};

export type EmptyParams = Record<string, never>;

export type HostApiMethods = {
	"host.bootstrap": {
		params: { includePreferences?: boolean };
		result: HostBootstrapWire;
	};
	"host.shutdown": { params: EmptyParams; result: void };
	"project.list": { params: EmptyParams; result: Project[] };
	"project.add": {
		params: { connectionId: string; path: string };
		result: Project;
	};
	"project.remove": { params: { projectId: string }; result: Project[] };
	"project.file.preview": {
		params: { projectId: string; url: string };
		result: WorkspaceFile | null;
	};
	"git.status": { params: { projectId: string }; result: GitStatus };
	"git.diff": {
		params: { projectId: string; path?: string; staged: boolean };
		result: string;
	};
	"terminal.open": {
		params: { projectId: string; cols: number; rows: number };
		result: TerminalInfo;
	};
	"terminal.write": { params: { terminalId: string }; result: void };
	"terminal.resize": {
		params: { terminalId: string; cols: number; rows: number };
		result: void;
	};
	"terminal.close": { params: { terminalId: string }; result: void };
	"terminal.attach": { params: { terminalId: string }; result: TerminalInfo };
	"terminal.snapshot": {
		params: { terminalId: string };
		result: TerminalSnapshot;
	};
	"connection.list": { params: EmptyParams; result: Connection[] };
	"connection.local.get": { params: EmptyParams; result: Connection };
	"connection.health": { params: { id: string }; result: ConnectionHealth };
	"connection.models": { params: { connectionId: string }; result: PiModel[] };
	"connection.namingModels.list": {
		params: EmptyParams;
		result: ConnectionNamingModel[];
	};
	"connection.namingModels.set": {
		params: {
			connectionId: string;
			provider?: string | null;
			modelId?: string | null;
		};
		result: ConnectionNamingModel | null;
	};
	"connection.readDir": {
		params: { connectionId: string; path: string };
		result: FsEntry[];
	};
	"connection.settings.update": {
		params: { id: string; name: string; piExecutable?: string | null };
		result: Connection;
	};
	"connection.shownInHome.set": {
		params: { id: string; shown: boolean };
		result: Connection;
	};
	"connection.pi.probe": {
		params: { id: string; executable?: string | null };
		result: PiExecutableInfo;
	};
	"connection.local.test": {
		params: EmptyParams;
		result: ConnectionTestResult;
	};
	"connection.localPiResources.set": {
		params: { connectionId: string; enabled: boolean };
		result: void;
	};
	"connection.ssh.list": { params: EmptyParams; result: SshConnectionInfo[] };
	"connection.ssh.agentIdentities": {
		params: EmptyParams;
		result: SshAgentIdentity[];
	};
	"connection.ssh.configHosts": {
		params: EmptyParams;
		result: SshConfigHost[];
	};
	"connection.ssh.localKeys": { params: EmptyParams; result: string[] };
	"connection.ssh.save": {
		params: {
			request: {
				connection: Connection;
				password?: string | null;
				localPiResources?: boolean;
			};
		};
		result: SshConnectionInfo;
	};
	"connection.ssh.password": { params: { id: string }; result: string | null };
	"connection.ssh.remove": { params: { id: string }; result: void };
	"connection.ssh.test": {
		params: { id: string };
		result: ConnectionTestResult;
	};
	"connection.ssh.testDraft": {
		params: { connection: Connection; password?: string | null };
		result: ConnectionTestResult;
	};
	"connection.wsl.distributions": {
		params: EmptyParams;
		result: WslDistribution[];
	};
	"connection.wsl.list": { params: EmptyParams; result: WslConnectionInfo[] };
	"connection.wsl.save": {
		params: { connection: Connection };
		result: WslConnectionInfo;
	};
	"connection.wsl.remove": { params: { id: string }; result: void };
	"connection.wsl.test": {
		params: { distro: string };
		result: ConnectionTestResult;
	};
	"remote.state": { params: EmptyParams; result: RemoteHostState };
	"remote.lanAddresses": { params: EmptyParams; result: string[] };
	"remote.enabled.set": {
		params: { enabled: boolean };
		result: RemoteHostState;
	};
	"remote.port.set": { params: { port: number }; result: RemoteHostState };
	"remote.addresses.set": {
		params: { addresses?: RemoteAccessAddress[]; entryAddressId: string };
		result: RemoteHostState;
	};
	"remote.pairing.regenerate": {
		params: { scopes: RemoteScopes };
		result: RemoteHostState;
	};
	"remote.device.revoke": {
		params: { deviceId: string };
		result: RemoteHostState;
	};
	"remote.device.rename": {
		params: { deviceId: string; name: string };
		result: RemoteHostState;
	};
	"remote.devices.setScopes": {
		params: { deviceId: string; scopes: RemoteScopes };
		result: RemoteHostState;
	};
	"remote.devices.revokeAll": {
		params: EmptyParams;
		result: RemoteHostState;
	};
	"device.revokeSelf": { params: EmptyParams; result: void };
	"preferences.get": { params: EmptyParams; result: PreferencesSnapshot };
	"preferences.patch": {
		params: { patch: PreferencePatch; initial?: boolean };
		result: PreferencesSnapshot;
	};
	"theme.get": { params: EmptyParams; result: ThemeSettings };
	"theme.set": {
		params: { update: ThemeSettingsUpdate };
		result: ThemeSettings;
	};
	"models.get": {
		params: { projectId: string };
		result: ProjectPiModels | null;
	};
	"models.set": { params: { cache: ProjectPiModels }; result: ProjectPiModels };
	"models.scope.get": {
		params: { projectId: string };
		result: ProjectModelScope;
	};
	"models.scope.set": {
		params: { projectId: string; models: ProjectScopedModel[] | null };
		result: ProjectModelScope;
	};
	"nextPrompt.settings.get": {
		params: { connectionId: string };
		result: NextPromptSettings;
	};
	"nextPrompt.settings.set": {
		params: {
			connectionId: string;
			enabled: boolean;
			model: NextPromptModel | null;
		};
		result: NextPromptSettings;
	};
	"nextPrompt.request": {
		params: { request: NextPromptRequest };
		result: void;
	};
	"promptEnhancement.settings.get": {
		params: { connectionId: string };
		result: PromptEnhancementSettings;
	};
	"promptEnhancement.settings.set": {
		params: {
			connectionId: string;
			enabled: boolean;
			model: PromptEnhancementModel | null;
		};
		result: PromptEnhancementSettings;
	};
	"promptEnhancement.enhance": {
		params: {
			projectId: string;
			draft: string;
			model: PromptEnhancementModel | null;
		};
		result: string;
	};
	"cacheKeepAlive.settings.list": {
		params: { connectionId: string };
		result: CacheKeepAliveSettings[];
	};
	"cacheKeepAlive.settings.set": {
		params: { settings: CacheKeepAliveSettings };
		result: CacheKeepAliveSettings;
	};
	"cacheKeepAlive.pause": { params: { sessionKey: string }; result: void };
	"session.list": {
		params: { projectId: string; cached?: boolean; unwatchedOnly?: boolean };
		result: SessionIndexEntry[];
	};
	"session.search": {
		params: { projectId: string; query: string; limit?: number };
		result: SessionSearchMatch[];
	};
	"session.externalActivity": {
		params: { projectId: string };
		result: SessionExternalActivity[];
	};
	"session.history": {
		params: {
			projectId: string;
			sessionPath: string;
			expectedFileSize?: number;
			expectedFileMtimeNs?: string;
			startMessage?: number;
			messageLimit?: number;
			includeMessageIndex?: boolean;
		};
		result: SessionHistoryResult;
	};
	"session.historyImage": {
		params: {
			projectId: string;
			sessionPath: string;
			imageId: string;
			expectedFileSize?: string;
			expectedFileMtimeNs?: string;
		};
		result: Uint8Array<ArrayBuffer>;
	};
	"session.title": {
		params: { projectId: string; message: string };
		result: string | null;
	};
	"session.delete": {
		params: { projectId: string; sessionPath: string };
		result: SessionDeleteResult;
	};
	"session.uiState.set": {
		params: {
			projectId?: string;
			sessionPath: string;
			update: SessionUiStateUpdate;
		};
		result: SessionIndexEntry;
	};
	"session.resolve": {
		params: { projectId: string; sessionId: string };
		result: unknown;
	};
	"session.page": {
		params: { projectId: string; offset?: number; limit?: number };
		result: unknown;
	};
	"session.create": {
		params: {
			projectId: string;
			sessionId: string;
			message: string;
			title?: string;
		};
		result: unknown;
	};
	"session.send": {
		params: { projectId: string; sessionId: string; message: string };
		result: unknown;
	};
	"session.abort": {
		params: { projectId: string; sessionId: string };
		result: unknown;
	};
	"session.stop": {
		params: { projectId: string; sessionId: string };
		result: unknown;
	};
	"session.update": {
		params: {
			projectId: string;
			sessionId: string;
			title?: string;
			pinned?: boolean;
		};
		result: SessionIndexEntry;
	};
	"session.trash": {
		params: { projectId: string; sessionId: string };
		result: unknown;
	};
	"desktop.open": {
		params: { path?: string; sessionId?: string };
		result: {
			projectId: string;
			project: string;
			path: string;
			added?: boolean;
			sessionId?: string;
			sessionPath?: string;
		};
	};
	"session.status": {
		params: { projectId: string; sessionId: string };
		result: {
			sessionId: string;
			state: "idle" | "running" | "compacting" | "not_running" | "error";
			turn: "idle" | "active" | "truncated" | null;
			runningTools: string[] | null;
			lastAssistantMessage: string | null;
		};
	};
	"session.readStates": { params: EmptyParams; result: SessionReadState[] };
	"session.markRead": {
		params: { projectId: string; sessionPath: string; revision: number };
		result: SessionReadState;
	};
	"chat.start": {
		params: PiloClientStartChatInput;
		result: PiSessionSnapshot;
	};
	"chat.stop": {
		params: { sessionKey: string; reason?: string };
		result: void;
	};
	"chat.state": {
		params: { sessionKey: string };
		result: ChatSessionRuntimeState | null;
	};
	"chat.transcript": {
		params: { sessionKey: string; window?: ChatTranscriptWindow };
		result: ChatTranscriptSnapshot;
	};
	"chat.rpc": {
		params: { sessionKey: string; command: Record<string, unknown> };
		result: void;
	};
	"chat.mcp.approve": {
		params: { projectId: string; serverName: string };
		result: void;
	};
	"files.search": {
		params: { projectId: string; query: string };
		result: string[];
	};
	"files.image": {
		params: { projectId: string; path: string };
		result: Uint8Array<ArrayBuffer>;
	};
	"chat.files.upload": {
		params: { projectId: string; name: string };
		result: string;
	};
	"chat.files.remove": {
		params: { projectId: string; path: string };
		result: void;
	};
};

export type HostApiMethodName = keyof HostApiMethods;

/**
 * Runtime metadata for every Host API method, verified against the generated
 * `host-methods.json` from Rust `host_api::methods()` in unit tests.
 */
export const HOST_API_METHOD_META: Record<
	HostApiMethodName,
	{ scope: HostApiScope; kind: HostApiMethodKind }
> = {
	"host.bootstrap": { scope: "chat", kind: "json" },
	"host.shutdown": { scope: "admin", kind: "json" },
	"project.list": { scope: "chat", kind: "json" },
	"project.add": { scope: "workspace", kind: "json" },
	"project.remove": { scope: "workspace", kind: "json" },
	"project.file.preview": { scope: "workspace", kind: "json" },
	"git.status": { scope: "workspace", kind: "json" },
	"git.diff": { scope: "workspace", kind: "json" },
	"terminal.open": { scope: "workspace", kind: "json" },
	"terminal.write": { scope: "workspace", kind: "binary_in" },
	"terminal.resize": { scope: "workspace", kind: "json" },
	"terminal.close": { scope: "workspace", kind: "json" },
	"terminal.attach": { scope: "workspace", kind: "json" },
	"terminal.snapshot": { scope: "workspace", kind: "json" },
	"connection.list": { scope: "chat", kind: "json" },
	"connection.local.get": { scope: "chat", kind: "json" },
	"connection.health": { scope: "chat", kind: "json" },
	"connection.models": { scope: "chat", kind: "json" },
	"connection.namingModels.list": { scope: "chat", kind: "json" },
	"connection.namingModels.set": { scope: "admin", kind: "json" },
	"connection.readDir": { scope: "workspace", kind: "json" },
	"connection.settings.update": { scope: "admin", kind: "json" },
	"connection.shownInHome.set": { scope: "admin", kind: "json" },
	"connection.pi.probe": { scope: "admin", kind: "json" },
	"connection.local.test": { scope: "admin", kind: "json" },
	"connection.localPiResources.set": { scope: "admin", kind: "json" },
	"connection.ssh.list": { scope: "chat", kind: "json" },
	"connection.ssh.agentIdentities": { scope: "admin", kind: "json" },
	"connection.ssh.configHosts": { scope: "admin", kind: "json" },
	"connection.ssh.localKeys": { scope: "admin", kind: "json" },
	"connection.ssh.save": { scope: "admin", kind: "json" },
	"connection.ssh.password": { scope: "admin", kind: "json" },
	"connection.ssh.remove": { scope: "admin", kind: "json" },
	"connection.ssh.test": { scope: "admin", kind: "json" },
	"connection.ssh.testDraft": { scope: "admin", kind: "json" },
	"connection.wsl.distributions": { scope: "admin", kind: "json" },
	"connection.wsl.list": { scope: "chat", kind: "json" },
	"connection.wsl.save": { scope: "admin", kind: "json" },
	"connection.wsl.remove": { scope: "admin", kind: "json" },
	"connection.wsl.test": { scope: "admin", kind: "json" },
	"remote.state": { scope: "admin", kind: "json" },
	"remote.lanAddresses": { scope: "admin", kind: "json" },
	"remote.enabled.set": { scope: "admin", kind: "json" },
	"remote.port.set": { scope: "admin", kind: "json" },
	"remote.addresses.set": { scope: "admin", kind: "json" },
	"remote.pairing.regenerate": { scope: "admin", kind: "json" },
	"remote.device.revoke": { scope: "admin", kind: "json" },
	"remote.device.rename": { scope: "admin", kind: "json" },
	"remote.devices.setScopes": { scope: "admin", kind: "json" },
	"remote.devices.revokeAll": { scope: "admin", kind: "json" },
	"device.revokeSelf": { scope: "chat", kind: "json" },
	"preferences.get": { scope: "chat", kind: "json" },
	"preferences.patch": { scope: "chat", kind: "json" },
	"theme.get": { scope: "chat", kind: "json" },
	"theme.set": { scope: "chat", kind: "json" },
	"models.get": { scope: "chat", kind: "json" },
	"models.set": { scope: "chat", kind: "json" },
	"models.scope.get": { scope: "chat", kind: "json" },
	"models.scope.set": { scope: "chat", kind: "json" },
	"nextPrompt.settings.get": { scope: "chat", kind: "json" },
	"nextPrompt.settings.set": { scope: "chat", kind: "json" },
	"nextPrompt.request": { scope: "chat", kind: "json" },
	"promptEnhancement.settings.get": { scope: "chat", kind: "json" },
	"promptEnhancement.settings.set": { scope: "chat", kind: "json" },
	"promptEnhancement.enhance": { scope: "chat", kind: "json" },
	"cacheKeepAlive.settings.list": { scope: "chat", kind: "json" },
	"cacheKeepAlive.settings.set": { scope: "chat", kind: "json" },
	"cacheKeepAlive.pause": { scope: "chat", kind: "json" },
	"session.list": { scope: "chat", kind: "json" },
	"session.search": { scope: "chat", kind: "json" },
	"session.externalActivity": { scope: "chat", kind: "json" },
	"session.history": { scope: "chat", kind: "json" },
	"session.historyImage": { scope: "chat", kind: "binary_out" },
	"session.title": { scope: "chat", kind: "json" },
	"session.delete": { scope: "chat", kind: "json" },
	"session.uiState.set": { scope: "chat", kind: "json" },
	"session.resolve": { scope: "admin", kind: "json" },
	"session.page": { scope: "admin", kind: "json" },
	"session.create": { scope: "admin", kind: "json" },
	"session.send": { scope: "admin", kind: "json" },
	"session.abort": { scope: "admin", kind: "json" },
	"session.stop": { scope: "admin", kind: "json" },
	"session.update": { scope: "admin", kind: "json" },
	"session.trash": { scope: "admin", kind: "json" },
	"session.status": { scope: "admin", kind: "json" },
	"desktop.open": { scope: "admin", kind: "json" },
	"session.readStates": { scope: "chat", kind: "json" },
	"session.markRead": { scope: "chat", kind: "json" },
	"chat.start": { scope: "chat", kind: "json" },
	"chat.stop": { scope: "chat", kind: "json" },
	"chat.state": { scope: "chat", kind: "json" },
	"chat.transcript": { scope: "chat", kind: "json" },
	"chat.rpc": { scope: "chat", kind: "json" },
	"chat.mcp.approve": { scope: "workspace", kind: "json" },
	"files.search": { scope: "chat", kind: "json" },
	"files.image": { scope: "chat", kind: "binary_out" },
	"chat.files.upload": { scope: "chat", kind: "binary_in" },
	"chat.files.remove": { scope: "chat", kind: "json" },
};
