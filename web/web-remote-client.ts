import {
	type Accessor,
	effect,
	lifecycle,
	signal,
	Storage,
	untracked,
	UrlScheme,
} from "nsh";

import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";
import type { ProjectPiModels } from "@shared/api/pi-models-types";
import type { PiModel, PiSessionSnapshot } from "@shared/api/pi-runtime-types";
import type {
	PiloClientBootstrap,
	PiloClientEventMessage,
	PiloClientEventOptions,
	PiloClientHistoryOptions,
	PiloClientStartChatInput,
} from "@shared/api/pilo-client";
import type { Project } from "@shared/api/projects-types";
import type {
	SessionDeleteResult,
	SessionExternalActivity,
	SessionHistoryFingerprint,
	SessionHistoryResult,
	SessionIndexEntry,
	SessionSearchMatch,
	SessionUiStateUpdate,
} from "@shared/api/sessions-types";
import { isDefaultWorkspace } from "@shared/api/projects-types";
import type {
	PreferencePatch,
	PreferencesSnapshot,
} from "@shared/host-preferences-types";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@shared/project-model-scope";
import { describeDevice } from "@shared/device-name";
import { randomId } from "@shared/random-id";
import {
	parseRemotePairResponse,
	parseRemotePairingInfo,
	type RemotePairingInfo,
} from "@shared/remote-pairing";
import type { SessionReadState } from "@shared/session-read-state";
import type {
	ThemeSettings,
	ThemeSettingsUpdate,
} from "@shared/theme-settings-types";

import type {
	ChatTranscriptSnapshot,
	ChatTranscriptWindow,
	NshPiloClientBootstrap,
} from "../app/client/nsh-pilo-client";
import type { AppStoreClient } from "../app/state/app-store";
import type { ChatRunConfigClient } from "../app/state/chat-run-config";
import type { ChatTranscriptClient } from "../app/state/chat-transcript-store";
import type { ModelCatalogClient } from "../app/state/model-catalog";
import type { ComposerClient } from "../app/composer/composer-store";
import type { SessionForkClient } from "../app/shell/session-fork";

export const REMOTE_TOKEN_KEY = "pilo.remote.device-token.v1";
export const REMOTE_SEQUENCE_KEY = "pilo.nsh.remote.sequence.v1";

const FOREGROUND_RESUME_MIN_HIDDEN_MS = 1_500;
const SOCKET_PROBE_TIMEOUT_MS = 5_000;
const OFFLINE_RETRY_DELAY_MS = 30_000;
const RECOVERED_NOTICE_MS = 2_500;

export type WebRemoteConnectionState = "connected" | "reconnecting" | "offline";
export type WebRemoteRecoveryState = "idle" | "reconnecting" | "recovered";

export class RemotePairingError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "RemotePairingError";
	}
}

type BrowserStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
};

type BrowserGlobal = {
	localStorage?: BrowserStorage;
	sessionStorage?: BrowserStorage & {
		readonly length: number;
		key(index: number): string | null;
	};
	parent?: Pick<BrowserGlobal, "location">;
	location?: {
		href?: string;
		assign?: (url: string) => void;
		replace?: (url: string) => void;
		reload?: () => void;
	};
	navigator?: { onLine?: boolean; userAgent?: string };
	crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array };
	addEventListener?: (type: string, listener: () => void) => void;
	removeEventListener?: (type: string, listener: () => void) => void;
};

function browserGlobal(): BrowserGlobal {
	return globalThis as unknown as BrowserGlobal;
}

function browserPageLocation(): BrowserGlobal["location"] {
	const browser = browserGlobal();
	try {
		// nsh runs app code in a hidden iframe; use the hosting page's address.
		const parentLocation = browser.parent?.location;
		if (parentLocation?.href) return parentLocation;
	} catch {
		// A cross-origin parent does not expose its address.
	}
	return browser.location;
}

function readBrowserLocalStorage(key: string): string | null {
	try {
		return browserGlobal().localStorage?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

function writeBrowserLocalStorage(key: string, value: string): void {
	try {
		browserGlobal().localStorage?.setItem(key, value);
	} catch {
		// Sandboxed realms or private mode may refuse localStorage.
	}
}

function removeBrowserLocalStorage(key: string): void {
	try {
		browserGlobal().localStorage?.removeItem(key);
	} catch {
		// Ignore storage cleanup failures.
	}
}

/**
 * Resolves the paired device token from URL hash (`#token=...`), same-origin
 * `localStorage` (shared with the React WebUI), or nsh's own `Storage`.
 */
export async function loadRemoteDeviceToken(): Promise<string | null> {
	try {
		const parsed = resolvePageAddress();
		const params = new URLSearchParams(parsed.hash.slice(1));
		const hashToken = params.get("token")?.trim();
		if (hashToken) {
			params.delete("token");
			const remaining = params.toString();
			parsed.hash = remaining ? `#${remaining}` : "";
			try {
				UrlScheme.setUrl(parsed.href, { history: "replace" });
			} catch {
				// Ignore if the host rejects URL mutation.
			}
			await saveRemoteDeviceToken(hashToken);
			return hashToken;
		}
	} catch {
		// Fall back to stored credentials if URL token handling fails.
	}

	const shared = readBrowserLocalStorage(REMOTE_TOKEN_KEY)?.trim();
	if (shared) {
		void Storage.setItem(REMOTE_TOKEN_KEY, shared).catch(() => undefined);
		return shared;
	}

	const stored = (
		await Storage.getItem(REMOTE_TOKEN_KEY).catch(() => null)
	)?.trim();
	if (stored) {
		writeBrowserLocalStorage(REMOTE_TOKEN_KEY, stored);
		return stored;
	}

	return null;
}

export async function saveRemoteDeviceToken(token: string): Promise<void> {
	const trimmed = token.trim();
	if (!trimmed) return;
	writeBrowserLocalStorage(REMOTE_TOKEN_KEY, trimmed);
	await Storage.setItem(REMOTE_TOKEN_KEY, trimmed).catch(() => undefined);
}

export async function clearRemoteDeviceToken(
	expectedToken?: string,
): Promise<void> {
	const currentShared = readBrowserLocalStorage(REMOTE_TOKEN_KEY);
	if (!expectedToken || currentShared === expectedToken) {
		removeBrowserLocalStorage(REMOTE_TOKEN_KEY);
	}
	const currentStored = await Storage.getItem(REMOTE_TOKEN_KEY).catch(
		() => null,
	);
	if (!expectedToken || currentStored === expectedToken) {
		await Storage.removeItem(REMOTE_TOKEN_KEY).catch(() => undefined);
	}
}

function parseHttpPageUrl(value: string | null | undefined): URL | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol === "http:" || url.protocol === "https:") return url;
	} catch {
		// Ignore invalid addresses.
	}
	return undefined;
}

function resolvePageAddress(): URL {
	const browserUrl = parseHttpPageUrl(browserPageLocation()?.href);
	const appUrl = parseHttpPageUrl(UrlScheme.url());
	// setUrl updates the app address before the browser history catches up.
	if (appUrl && (!browserUrl || appUrl.origin === browserUrl.origin)) {
		return appUrl;
	}
	return browserUrl ?? new URL("http://127.0.0.1:47653/");
}

export function resolveCurrentPageUrl(): string {
	return resolvePageAddress().href;
}

export function resolvePageOrigin(): string {
	return resolvePageAddress().origin;
}

export function navigateToUrl(
	url: string,
	options?: { replace?: boolean },
): void {
	const location = browserPageLocation();
	if (options?.replace && location?.replace) {
		location.replace(url);
		return;
	}
	if (location?.assign) {
		location.assign(url);
		return;
	}
	try {
		UrlScheme.setUrl(url, { history: options?.replace ? "replace" : "push" });
	} catch {
		// Ignore when running outside a browser host.
	}
}

export function reloadRemotePage(): void {
	browserPageLocation()?.reload?.();
}

export function browserSessionStorage(): BrowserGlobal["sessionStorage"] {
	try {
		return browserGlobal().sessionStorage;
	} catch {
		return undefined;
	}
}

export function browserRandomBytes(size: number): Uint8Array {
	const getRandomValues = browserGlobal().crypto?.getRandomValues;
	if (typeof getRandomValues !== "function") {
		throw new Error("REMOTE_PAIRING_RANDOM_UNAVAILABLE");
	}
	return getRandomValues.call(browserGlobal().crypto, new Uint8Array(size));
}

function isBrowserOnline(): boolean {
	const onLine = browserGlobal().navigator?.onLine;
	return typeof onLine === "boolean" ? onLine : true;
}

async function decodeError(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: string };
		return body.error || response.statusText || `HTTP ${response.status}`;
	} catch {
		return response.statusText || `HTTP ${response.status}`;
	}
}

async function pairingRequest(
	path: string,
	body: object,
	origin = resolvePageOrigin(),
): Promise<unknown> {
	const response = await fetch(new URL(path, origin).href, {
		method: "POST",
		cache: "no-store",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new RemotePairingError(response.status, await decodeError(response));
	}
	return response.json();
}

export async function getRemotePairingInfo(
	secret: string,
	origin = resolvePageOrigin(),
): Promise<RemotePairingInfo> {
	return parseRemotePairingInfo(
		await pairingRequest("/api/v1/auth/pairing", { secret }, origin),
	);
}

export async function pairRemote(
	secret: string,
	addressId: string,
	requestId: string,
	origin = resolvePageOrigin(),
): Promise<{ token: string; expiresAtMs: number }> {
	const ua = browserGlobal().navigator?.userAgent ?? "";
	return parseRemotePairResponse(
		await pairingRequest(
			"/api/v1/auth/pair",
			{
				secret,
				addressId,
				requestId,
				deviceName: describeDevice(ua),
			},
			origin,
		),
	);
}

export async function verifyRemoteToken(
	token: string,
	origin = resolvePageOrigin(),
): Promise<void> {
	const response = await fetch(new URL("/api/v1/bootstrap", origin).href, {
		cache: "no-store",
		headers: { authorization: `Bearer ${token}` },
	});
	if (response.status === 401) {
		await clearRemoteDeviceToken(token);
		throw new Error("REMOTE_AUTH_EXPIRED");
	}
	if (!response.ok) throw new Error(await decodeError(response));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProject(project: Project): Project {
	if (!isDefaultWorkspace(project)) return project;
	return project;
}

export type WebRemoteClient = AppStoreClient &
	ChatTranscriptClient &
	ChatRunConfigClient &
	ModelCatalogClient &
	ComposerClient &
	SessionForkClient & {
		readonly connectionState: Accessor<WebRemoteConnectionState>;
		readonly recoveryState: Accessor<WebRemoteRecoveryState>;
		reconnectNow(): void;
		dispose(): void;
		savePreferences(patch: PreferencePatch): Promise<PreferencesSnapshot>;
		saveThemeSettings(update: ThemeSettingsUpdate): Promise<ThemeSettings>;
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
		pauseCacheKeepAlive(sessionKey: string): Promise<void>;
	};

/**
 * HTTP + WebSocket client for Pilo's Remote WebUI API (`/api/v1/*`), built for
 * nsh Web. Multiplexes every store's `connectEvents` subscription onto one
 * resilient WebSocket with foreground resume probing and exponential backoff.
 */
export class WebRemotePiloClient implements WebRemoteClient {
	private readonly token: string;
	private readonly origin: string;
	private readonly onAuthExpired: () => void;
	private readonly listeners = new Set<PiloClientEventOptions>();
	private readonly connectionSignal =
		signal<WebRemoteConnectionState>("reconnecting");
	private readonly recoverySignal = signal<WebRemoteRecoveryState>("idle");
	private readonly onlineSignal = signal<boolean>(isBrowserOnline());

	readonly connectionState: Accessor<WebRemoteConnectionState> =
		this.connectionSignal;
	readonly recoveryState: Accessor<WebRemoteRecoveryState> =
		this.recoverySignal;
	readonly reconnectsEvents = true;
	readonly rpcIdPrefix = `nsh-rpc-${randomId()}`;

	private socket: WebSocket | null = null;
	private socketReady = false;
	private disposed = false;
	private replayCursor = 0;
	private hasConnectedOnce = false;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private probeTimer: ReturnType<typeof setTimeout> | undefined;
	private recoveredTimer: ReturnType<typeof setTimeout> | undefined;
	private hiddenAt: number | null = null;
	private removeNetworkListeners: (() => void) | undefined;
	private stopLifecycleWatch: (() => void) | undefined;

	constructor(
		token: string,
		options?: {
			origin?: string;
			onAuthExpired?: () => void;
		},
	) {
		this.token = token;
		this.origin = options?.origin ?? resolvePageOrigin();
		this.onAuthExpired = options?.onAuthExpired ?? (() => undefined);

		const savedSeq = Number(
			readBrowserLocalStorage(REMOTE_SEQUENCE_KEY) ?? "0",
		);
		if (Number.isSafeInteger(savedSeq) && savedSeq > 0) {
			this.replayCursor = savedSeq;
		}

		this.bindEnvironmentEvents();
	}

	get closed(): boolean {
		return this.disposed;
	}

	private apiUrl(path: string): string {
		return new URL(path, this.origin).href;
	}

	private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
		const headers = new Headers(init?.headers);
		headers.set("authorization", `Bearer ${this.token}`);
		if (init?.body && !headers.has("content-type")) {
			headers.set("content-type", "application/json");
		}
		const response = await fetch(this.apiUrl(path), { ...init, headers });
		if (response.status === 401) {
			void clearRemoteDeviceToken(this.token);
			this.dispose();
			this.onAuthExpired();
			throw new Error("REMOTE_AUTH_EXPIRED");
		}
		if (!response.ok) throw new Error(await decodeError(response));
		if (response.status === 204) return undefined as T;
		return (await response.json()) as T;
	}

	private async requestBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
		const response = await fetch(this.apiUrl(path), {
			headers: { authorization: `Bearer ${this.token}` },
		});
		if (response.status === 401) {
			void clearRemoteDeviceToken(this.token);
			this.dispose();
			this.onAuthExpired();
			throw new Error("REMOTE_AUTH_EXPIRED");
		}
		if (!response.ok) throw new Error(await decodeError(response));
		return new Uint8Array(await response.arrayBuffer());
	}

	async bootstrap(): Promise<NshPiloClientBootstrap> {
		const remote = await this.requestJson<PiloClientBootstrap>(
			"/api/v1/bootstrap",
			{ cache: "no-store" },
		);
		// Preferences must include every change at or below the snapshot cut.
		const preferences = await this.requestJson<PreferencesSnapshot>(
			"/api/v1/preferences",
			{ cache: "no-store" },
		);
		return {
			projects: remote.projects.map(normalizeProject),
			chatSessions: remote.chatSessions,
			latestSequence: remote.latestSequence,
			preferences,
		};
	}

	async listProjects(): Promise<Project[]> {
		const snapshot = await this.requestJson<PiloClientBootstrap>(
			"/api/v1/bootstrap",
			{ cache: "no-store" },
		);
		return snapshot.projects.map(normalizeProject);
	}

	addProject(_connectionId: string, _path: string): Promise<Project> {
		return Promise.reject(
			new Error("Adding projects is available in the desktop app."),
		);
	}

	removeProject(_projectId: string): Promise<Project[]> {
		return Promise.reject(
			new Error("Removing projects is available in the desktop app."),
		);
	}

	listSessions(
		projectId: string,
		cached = false,
		_unwatchedOnly = false,
	): Promise<SessionIndexEntry[]> {
		const query = new URLSearchParams({ projectId });
		if (cached) query.set("cached", "true");
		return this.requestJson<SessionIndexEntry[]>(
			`/api/v1/sessions?${query.toString()}`,
			{ cache: "no-store" },
		);
	}

	externalSessionActivity(
		projectId: string,
	): Promise<SessionExternalActivity[]> {
		const query = new URLSearchParams({ projectId });
		return this.requestJson<SessionExternalActivity[]>(
			`/api/v1/sessions/external-activity?${query.toString()}`,
			{ cache: "no-store" },
		);
	}

	deleteSession(
		projectId: string,
		sessionPath: string,
	): Promise<SessionDeleteResult> {
		return this.requestJson<SessionDeleteResult>("/api/v1/sessions/delete", {
			method: "POST",
			body: JSON.stringify({ projectId, sessionPath }),
		});
	}

	updateSessionUiState(
		sessionPath: string,
		update: SessionUiStateUpdate,
		projectId?: string,
	): Promise<SessionIndexEntry> {
		return this.requestJson<SessionIndexEntry>("/api/v1/sessions/ui-state", {
			method: "POST",
			body: JSON.stringify({ projectId, sessionPath, update }),
		});
	}

	pauseCacheKeepAlive(sessionKey: string): Promise<void> {
		return this.requestJson<void>("/api/v1/cache-keep-alive/pause", {
			method: "POST",
			body: JSON.stringify({ sessionKey }),
		});
	}

	loadSessionReadStates(): Promise<SessionReadState[]> {
		return this.requestJson<SessionReadState[]>("/api/v1/sessions/read-state", {
			cache: "no-store",
		});
	}

	markSessionRead(
		projectId: string,
		sessionPath: string,
		revision: number,
	): Promise<SessionReadState> {
		return this.requestJson<SessionReadState>("/api/v1/sessions/read-state", {
			method: "POST",
			body: JSON.stringify({ projectId, sessionPath, revision }),
		});
	}

	savePreferences(patch: PreferencePatch): Promise<PreferencesSnapshot> {
		return this.requestJson<PreferencesSnapshot>("/api/v1/preferences", {
			method: "POST",
			body: JSON.stringify(patch),
		});
	}

	loadThemeSettings(): Promise<ThemeSettings> {
		return this.requestJson<ThemeSettings>("/api/v1/theme", {
			cache: "no-store",
		});
	}

	saveThemeSettings(update: ThemeSettingsUpdate): Promise<ThemeSettings> {
		return this.requestJson<ThemeSettings>("/api/v1/theme", {
			method: "POST",
			body: JSON.stringify(update),
		});
	}

	loadHistory(
		projectId: string,
		sessionPath: string,
		options?: PiloClientHistoryOptions,
	): Promise<SessionHistoryResult> {
		const query = new URLSearchParams({
			projectId,
			sessionPath,
			messageLimit: String(options?.messageLimit ?? 256),
			includeMessageIndex: String(options?.includeMessageIndex ?? true),
		});
		if (options?.startMessage !== undefined) {
			query.set("startMessage", String(options.startMessage));
		}
		if (options?.fingerprint) {
			query.set("expectedFileSize", String(options.fingerprint.fileSize));
			query.set("expectedFileMtimeNs", options.fingerprint.fileMtimeNs);
		}
		return this.requestJson<SessionHistoryResult>(
			`/api/v1/history?${query.toString()}`,
		);
	}

	readHistoryImage(
		projectId: string,
		sessionPath: string,
		imageId: string,
		fingerprint?: SessionHistoryFingerprint,
	): Promise<Uint8Array<ArrayBuffer>> {
		const query = new URLSearchParams({ projectId, sessionPath, imageId });
		if (fingerprint) {
			query.set("expectedFileSize", String(fingerprint.fileSize));
			query.set("expectedFileMtimeNs", fingerprint.fileMtimeNs);
		}
		return this.requestBytes(`/api/v1/history/image?${query.toString()}`);
	}

	readProjectImage(
		projectId: string,
		path: string,
	): Promise<Uint8Array<ArrayBuffer>> {
		const query = new URLSearchParams({ projectId, path });
		return this.requestBytes(`/api/v1/files/image?${query.toString()}`);
	}

	startChat(input: PiloClientStartChatInput): Promise<PiSessionSnapshot> {
		return this.requestJson<PiSessionSnapshot>("/api/v1/chat/start", {
			method: "POST",
			body: JSON.stringify(input),
		});
	}

	stopChat(sessionKey: string, reason?: string): Promise<void> {
		return this.requestJson<void>("/api/v1/chat/stop", {
			method: "POST",
			body: JSON.stringify({ sessionKey, reason }),
		});
	}

	approveProjectMcpServer(
		projectId: string,
		serverName: string,
	): Promise<void> {
		return this.requestJson<void>("/api/v1/chat/mcp-approve", {
			method: "POST",
			body: JSON.stringify({ projectId, serverName }),
		});
	}

	chatState(sessionKey: string): Promise<ChatSessionRuntimeState | null> {
		const query = new URLSearchParams({ sessionKey });
		return this.requestJson<ChatSessionRuntimeState | null>(
			`/api/v1/chat/state?${query.toString()}`,
			{ cache: "no-store" },
		);
	}

	chatTranscriptSnapshot(
		sessionKey: string,
		window?: ChatTranscriptWindow,
	): Promise<ChatTranscriptSnapshot> {
		const query = new URLSearchParams({ sessionKey });
		if (window?.startMessage !== undefined) {
			query.set("startMessage", String(window.startMessage));
		}
		if (window?.messageLimit !== undefined) {
			query.set("messageLimit", String(window.messageLimit));
		}
		if (window?.includeMessageIndex !== undefined) {
			query.set("includeMessageIndex", String(window.includeMessageIndex));
		}
		return this.requestJson<ChatTranscriptSnapshot>(
			`/api/v1/chat/transcript?${query.toString()}`,
			{ cache: "no-store" },
		);
	}

	sendChatCommand(
		sessionKey: string,
		command: Record<string, unknown>,
	): Promise<void> {
		return this.requestJson<void>("/api/v1/chat/rpc", {
			method: "POST",
			body: JSON.stringify({ sessionKey, command }),
		});
	}

	searchProjectFiles(projectId: string, query: string): Promise<string[]> {
		const params = new URLSearchParams({ projectId, query });
		return this.requestJson<string[]>(
			`/api/v1/files/search?${params.toString()}`,
		);
	}

	searchSessions(
		projectId: string,
		query: string,
		limit = 24,
	): Promise<SessionSearchMatch[]> {
		const params = new URLSearchParams({
			projectId,
			query,
			limit: String(limit),
		});
		return this.requestJson<SessionSearchMatch[]>(
			`/api/v1/sessions/search?${params.toString()}`,
		);
	}

	uploadChatFile(
		projectId: string,
		name: string,
		data: Uint8Array,
	): Promise<string> {
		const query = new URLSearchParams({ projectId, name });
		const bytes = new Uint8Array(data);
		return this.requestJson<string>(`/api/v1/chat/files?${query.toString()}`, {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: bytes,
		});
	}

	removeChatFile(projectId: string, path: string): Promise<void> {
		const query = new URLSearchParams({ projectId, path });
		return this.requestJson<void>(`/api/v1/chat/files?${query.toString()}`, {
			method: "DELETE",
		});
	}

	generateSessionTitle(
		projectId: string,
		message: string,
	): Promise<string | null> {
		return this.requestJson<string | null>("/api/v1/sessions/title", {
			method: "POST",
			body: JSON.stringify({ projectId, message }),
		});
	}

	loadModels(projectId: string): Promise<ProjectPiModels | null> {
		const query = new URLSearchParams({ projectId });
		return this.requestJson<ProjectPiModels | null>(
			`/api/v1/models?${query.toString()}`,
		);
	}

	saveModels(snapshot: ProjectPiModels): Promise<ProjectPiModels> {
		return this.requestJson<ProjectPiModels>("/api/v1/models", {
			method: "POST",
			body: JSON.stringify(snapshot),
		});
	}

	loadModelScope(projectId: string): Promise<ProjectModelScope> {
		const query = new URLSearchParams({ projectId });
		return this.requestJson<ProjectModelScope>(
			`/api/v1/models/scope?${query.toString()}`,
		);
	}

	saveModelScope(
		projectId: string,
		models: ProjectScopedModel[] | null,
	): Promise<ProjectModelScope> {
		return this.requestJson<ProjectModelScope>("/api/v1/models/scope", {
			method: "POST",
			body: JSON.stringify({ projectId, models }),
		});
	}

	loadConnectionModels(connectionId: string): Promise<PiModel[]> {
		const query = new URLSearchParams({ connectionId });
		return this.requestJson<PiModel[]>(
			`/api/v1/connections/models?${query.toString()}`,
		);
	}

	/** Registers immediately; onStatus(true) signals the Host is listening. */
	connectEvents(options: PiloClientEventOptions): Promise<() => void> {
		if (this.disposed) {
			options.onStatus(false);
			return Promise.resolve(() => undefined);
		}
		this.listeners.add(options);
		if (this.socketReady && this.socket?.readyState === WebSocket.OPEN) {
			options.onStatus(true);
		}
		this.ensureSocket();
		return Promise.resolve(() => {
			this.listeners.delete(options);
			if (this.listeners.size === 0) {
				this.closeSocketOnly();
			}
		});
	}

	reconnectNow(): void {
		if (this.disposed) return;
		this.reconnectAttempts = 0;
		this.clearReconnectTimer();
		this.clearProbeTimer();
		this.connectionSignal.set(this.onlineSignal() ? "reconnecting" : "offline");
		this.recoverySignal.set("reconnecting");
		if (this.socket) {
			this.closeSocketOnly();
			this.notifyStatus(false);
		}
		this.ensureSocket();
	}

	private replayCursorTimer: ReturnType<typeof setTimeout> | undefined;
	private persistedReplayCursor: number | undefined;

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.flushReplayCursor();
		this.clearReconnectTimer();
		this.clearProbeTimer();
		this.clearRecoveredTimer();
		this.removeNetworkListeners?.();
		this.removeNetworkListeners = undefined;
		this.stopLifecycleWatch?.();
		this.stopLifecycleWatch = undefined;
		this.closeSocketOnly();
		const active = [...this.listeners];
		this.listeners.clear();
		for (const listener of active) listener.onStatus(false);
	}

	private flushReplayCursor(): void {
		if (this.replayCursorTimer !== undefined) {
			clearTimeout(this.replayCursorTimer);
			this.replayCursorTimer = undefined;
		}
		if (this.persistedReplayCursor === this.replayCursor) return;
		this.persistedReplayCursor = this.replayCursor;
		writeBrowserLocalStorage(REMOTE_SEQUENCE_KEY, String(this.replayCursor));
	}

	private setReplayCursor(sequence: number, immediate = false): void {
		if (sequence === this.replayCursor) return;
		this.replayCursor = sequence;
		if (immediate) {
			this.flushReplayCursor();
			return;
		}
		if (this.replayCursorTimer === undefined) {
			this.replayCursorTimer = setTimeout(() => {
				this.replayCursorTimer = undefined;
				this.flushReplayCursor();
			}, 1_000);
		}
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer !== undefined) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
	}

	private clearProbeTimer(): void {
		if (this.probeTimer !== undefined) {
			clearTimeout(this.probeTimer);
			this.probeTimer = undefined;
		}
	}

	private clearRecoveredTimer(): void {
		if (this.recoveredTimer !== undefined) {
			clearTimeout(this.recoveredTimer);
			this.recoveredTimer = undefined;
		}
	}

	private bindEnvironmentEvents(): void {
		const win = browserGlobal();
		const handleOnline = () => {
			this.onlineSignal.set(true);
			if (!this.disposed && this.listeners.size > 0) {
				this.reconnectNow();
			}
		};
		const handleOffline = () => {
			this.onlineSignal.set(false);
			this.connectionSignal.set("offline");
		};
		const handlePageHide = () => {
			this.flushReplayCursor();
		};
		if (win.addEventListener && win.removeEventListener) {
			win.addEventListener("online", handleOnline);
			win.addEventListener("offline", handleOffline);
			win.addEventListener("pagehide", handlePageHide);
			this.removeNetworkListeners = () => {
				win.removeEventListener?.("online", handleOnline);
				win.removeEventListener?.("offline", handleOffline);
				win.removeEventListener?.("pagehide", handlePageHide);
			};
		}

		// Track foreground/background transitions via nsh's reactive `lifecycle()`.
		let disposed = false;
		effect(() => {
			const state = lifecycle();
			if (disposed || this.disposed) return;
			untracked(() => this.handleLifecycleChange(state));
		});
		this.stopLifecycleWatch = () => {
			disposed = true;
		};
	}

	private handleLifecycleChange(
		state: "active" | "inactive" | "background",
	): void {
		if (state === "background") {
			this.hiddenAt = Date.now();
			this.flushReplayCursor();
			this.clearProbeTimer();
			return;
		}
		if (state !== "active") return;
		const suspendedAt = this.hiddenAt;
		this.hiddenAt = null;

		// Backoff timers can be frozen in background mobile tabs: reconnect immediately.
		if (this.reconnectTimer !== undefined && this.onlineSignal()) {
			this.reconnectNow();
			return;
		}

		if (
			suspendedAt === null ||
			Date.now() - suspendedAt < FOREGROUND_RESUME_MIN_HIDDEN_MS
		) {
			return;
		}
		if (this.listeners.size === 0) return;

		const socket = this.socket;
		if (
			!socket ||
			(socket.readyState !== WebSocket.OPEN &&
				socket.readyState !== WebSocket.CONNECTING)
		) {
			this.reconnectNow();
			return;
		}

		// Probe the existing socket so a half-open mobile TCP connection recovers quickly.
		this.clearProbeTimer();
		this.probeTimer = setTimeout(() => {
			this.probeTimer = undefined;
			this.reconnectNow();
		}, SOCKET_PROBE_TIMEOUT_MS);

		if (socket.readyState === WebSocket.OPEN) {
			try {
				socket.send(JSON.stringify({ type: "ping" }));
			} catch {
				this.reconnectNow();
			}
		}
	}

	private ensureSocket(): void {
		if (this.disposed || this.socket || this.reconnectTimer !== undefined) {
			return;
		}
		this.openSocket();
	}

	private closeSocketOnly(): void {
		const socket = this.socket;
		this.socket = null;
		this.socketReady = false;
		if (!socket) return;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
		try {
			socket.close();
		} catch {
			// Ignore close errors.
		}
	}

	private openSocket(): void {
		if (this.disposed || this.listeners.size === 0) return;
		this.clearReconnectTimer();
		this.clearProbeTimer();

		const url = new URL("/api/v1/events", this.origin);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		// An explicit 0 still asks for replay if no event has been consumed yet.
		url.searchParams.set("after", String(this.replayCursor));

		let socket: WebSocket;
		try {
			socket = new WebSocket(url.href, ["pilo", `pilo-token.${this.token}`]);
		} catch {
			this.notifyStatus(false);
			this.scheduleReconnect();
			return;
		}

		this.socket = socket;

		socket.onmessage = (event) => {
			if (this.socket !== socket || this.disposed) return;
			this.clearProbeTimer();
			try {
				const parsed: unknown = JSON.parse(String(event.data));
				if (!isRecord(parsed)) return;
				if (parsed.type === "pong") return;
				if (
					parsed.type === "hello" &&
					typeof parsed.latestSequence === "number"
				) {
					// The Host subscribes before hello, but sends replay after it.
					// A lower watermark means the Host restarted; never advance here.
					const reset = parsed.latestSequence < this.replayCursor;
					if (reset) this.setReplayCursor(0, true);
					this.acceptHello(reset);
					this.broadcast(parsed as PiloClientEventMessage);
					return;
				}
				let consumed = this.replayCursor;
				if (
					parsed.type === "resyncRequired" &&
					typeof parsed.latestSequence === "number"
				) {
					consumed = Math.max(consumed, parsed.latestSequence);
				} else if (parsed.type === "events" && Array.isArray(parsed.events)) {
					for (const item of parsed.events) {
						if (isRecord(item) && typeof item.sequence === "number") {
							consumed = Math.max(consumed, item.sequence);
						}
					}
				}
				this.broadcast(parsed as PiloClientEventMessage);
				if (this.socket === socket) this.setReplayCursor(consumed);
			} catch {
				// Ignore malformed frames; reconnect/resync handles recovery.
			}
		};

		const handleClose = () => {
			if (this.socket !== socket) return;
			this.closeSocketOnly();
			this.clearProbeTimer();
			if (this.disposed || this.listeners.size === 0) return;
			this.connectionSignal.set(
				this.onlineSignal() ? "reconnecting" : "offline",
			);
			this.recoverySignal.set("reconnecting");
			this.notifyStatus(false);
			void this.probeAuthOnDisconnect();
			this.scheduleReconnect();
		};

		socket.onerror = () => {
			// Wait for onclose to schedule reconnect; closing ensures stuck sockets tear down.
			if (
				socket.readyState === WebSocket.OPEN ||
				socket.readyState === WebSocket.CONNECTING
			) {
				try {
					socket.close();
				} catch {
					// Ignore close errors.
				}
			}
		};
		socket.onclose = handleClose;
	}

	private acceptHello(reset: boolean): void {
		if (this.socketReady) return;
		const wasReconnect = this.hasConnectedOnce;
		this.hasConnectedOnce = true;
		this.socketReady = true;
		this.reconnectAttempts = 0;
		this.connectionSignal.set("connected");
		if (wasReconnect && this.recoverySignal() === "reconnecting") {
			this.recoverySignal.set("recovered");
			this.clearRecoveredTimer();
			this.recoveredTimer = setTimeout(() => {
				this.recoveredTimer = undefined;
				if (this.recoverySignal() === "recovered") {
					this.recoverySignal.set("idle");
				}
			}, RECOVERED_NOTICE_MS);
		}
		// Re-read snapshots on reconnect without advancing the replay cursor.
		if (wasReconnect || reset) {
			this.broadcast({
				type: "resyncRequired",
				latestSequence: this.replayCursor,
			});
		}
		if (this.socketReady) this.notifyStatus(true);
	}

	private async probeAuthOnDisconnect(): Promise<void> {
		if (!this.onlineSignal() || this.disposed) return;
		try {
			await this.requestJson<unknown>("/api/v1/auth/device", {
				cache: "no-store",
			});
		} catch {
			// 401 is handled inside requestJson; transient network errors are ignored.
		}
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.listeners.size === 0) return;
		this.clearReconnectTimer();
		const online = this.onlineSignal();
		const delay = online
			? Math.min(
					1_500 * 2 ** Math.min(this.reconnectAttempts, 4),
					OFFLINE_RETRY_DELAY_MS,
				)
			: OFFLINE_RETRY_DELAY_MS;
		this.reconnectAttempts += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.openSocket();
		}, delay);
	}

	private notifyStatus(connected: boolean): void {
		for (const listener of [...this.listeners]) {
			listener.onStatus(connected);
		}
	}

	private broadcast(message: PiloClientEventMessage): void {
		for (const listener of [...this.listeners]) {
			listener.onMessage(message);
		}
	}
}
