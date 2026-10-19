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
import { describeDevice } from "@/lib/device-name";
import { registerChatFile } from "@/lib/chat/chat-file-lifecycle";
import type { SessionReadState } from "@/lib/session-read-state";
import type { RemoteAccessAddress } from "@/lib/api/remote";
import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-client";
import type {
	PiloClientBootstrap,
	PiloClientEventMessage,
	PiloClientHistoryOptions,
	PiloClientStartChatInput,
} from "@/lib/api/pilo-client";
import type { ProjectPiModels } from "@/lib/api/pi-models";
import type { PiSessionSnapshot } from "@/lib/api/pi-runtime";
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

export const REMOTE_TOKEN_KEY = "pilo.remote.device-token.v1";
export const REMOTE_SEQUENCE_KEY = "pilo.remote.sequence.v1";

const FOREGROUND_RESUME_MIN_HIDDEN_MS = 1_500;
const SOCKET_PROBE_TIMEOUT_MS = 5_000;

async function decodeError(response: Response) {
	try {
		const body = (await response.json()) as { error?: string };
		return body.error || response.statusText;
	} catch {
		return response.statusText;
	}
}

export type RemotePairingAddress = RemoteAccessAddress & { issued: boolean };

export type RemotePairingInfo = {
	addresses: RemotePairingAddress[];
	expiresAtMs: number;
	remainingUses: number;
};

export class RemotePairingError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "RemotePairingError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pairingRequest(path: string, body: object): Promise<unknown> {
	const response = await fetch(path, {
		method: "POST",
		cache: "no-store",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok)
		throw new RemotePairingError(response.status, await decodeError(response));
	return response.json();
}

export async function getRemotePairingInfo(
	secret: string,
): Promise<RemotePairingInfo> {
	const value = await pairingRequest("/api/v1/auth/pairing", { secret });
	if (
		!isRecord(value) ||
		!Array.isArray(value.addresses) ||
		typeof value.expiresAtMs !== "number" ||
		!Number.isSafeInteger(value.expiresAtMs) ||
		typeof value.remainingUses !== "number" ||
		!Number.isSafeInteger(value.remainingUses)
	)
		throw new Error("REMOTE_PAIRING_INVALID_RESPONSE");
	const addresses = value.addresses.map(
		(address: unknown): RemotePairingAddress => {
			if (
				!isRecord(address) ||
				typeof address.id !== "string" ||
				!/^[a-zA-Z0-9-]{1,80}$/.test(address.id) ||
				typeof address.name !== "string" ||
				typeof address.baseUrl !== "string" ||
				typeof address.issued !== "boolean"
			)
				throw new Error("REMOTE_PAIRING_INVALID_RESPONSE");
			const url = new URL(address.baseUrl);
			if (!/^https?:$/.test(url.protocol) || url.origin !== address.baseUrl)
				throw new Error("REMOTE_PAIRING_INVALID_RESPONSE");
			return {
				id: address.id,
				name: address.name,
				baseUrl: address.baseUrl,
				issued: address.issued,
			};
		},
	);
	if (
		!addresses.length ||
		addresses.length > 32 ||
		value.remainingUses < 0 ||
		value.remainingUses > addresses.length ||
		new Set(addresses.map((address) => address.id)).size !== addresses.length
	)
		throw new Error("REMOTE_PAIRING_INVALID_RESPONSE");
	return {
		addresses,
		expiresAtMs: value.expiresAtMs,
		remainingUses: value.remainingUses,
	};
}

export async function pairRemote(
	secret: string,
	addressId: string,
	requestId: string,
) {
	const value = await pairingRequest("/api/v1/auth/pair", {
		secret,
		addressId,
		requestId,
		deviceName: describeDevice(navigator.userAgent),
	});
	if (
		!isRecord(value) ||
		typeof value.token !== "string" ||
		!/^[a-zA-Z0-9_-]{43}$/.test(value.token) ||
		!isRecord(value.device) ||
		typeof value.device.id !== "string" ||
		typeof value.device.expiresAtMs !== "number" ||
		!Number.isSafeInteger(value.device.expiresAtMs) ||
		value.device.expiresAtMs <= Date.now()
	)
		throw new Error("REMOTE_PAIRING_INVALID_RESPONSE");
	return { token: value.token, expiresAtMs: value.device.expiresAtMs };
}

export async function remoteFetch<T>(
	token: string,
	path: string,
	init?: RequestInit,
): Promise<T> {
	const headers = new Headers(init?.headers);
	headers.set("authorization", `Bearer ${token}`);
	if (init?.body && !headers.has("content-type")) {
		headers.set("content-type", "application/json");
	}
	const response = await fetch(path, { ...init, headers });
	if (response.status === 401) {
		if (window.localStorage.getItem(REMOTE_TOKEN_KEY) === token) {
			window.localStorage.removeItem(REMOTE_TOKEN_KEY);
		}
		throw new Error("REMOTE_AUTH_EXPIRED");
	}
	if (!response.ok) throw new Error(await decodeError(response));
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

async function remoteFetchBytes(
	token: string,
	path: string,
): Promise<Uint8Array<ArrayBuffer>> {
	const response = await fetch(path, {
		headers: { authorization: `Bearer ${token}` },
	});
	if (response.status === 401) {
		if (window.localStorage.getItem(REMOTE_TOKEN_KEY) === token) {
			window.localStorage.removeItem(REMOTE_TOKEN_KEY);
		}
		throw new Error("REMOTE_AUTH_EXPIRED");
	}
	if (!response.ok) throw new Error(await decodeError(response));
	return new Uint8Array(await response.arrayBuffer());
}

export function loadRemoteThemeSettings(token: string) {
	return remoteFetch<ThemeSettings>(token, "/api/v1/theme", {
		cache: "no-store",
	});
}

export function saveRemoteThemeSettings(
	token: string,
	update: ThemeSettingsUpdate,
) {
	return remoteFetch<ThemeSettings>(token, "/api/v1/theme", {
		method: "POST",
		body: JSON.stringify(update),
	});
}

export function loadRemoteBootstrap(token: string) {
	return remoteFetch<PiloClientBootstrap>(token, "/api/v1/bootstrap");
}

export function loadRemoteSessions(
	token: string,
	projectId: string,
	cached = false,
) {
	const query = new URLSearchParams({ projectId });
	if (cached) query.set("cached", "true");
	return remoteFetch<SessionIndexEntry[]>(
		token,
		`/api/v1/sessions?${query.toString()}`,
		{ cache: "no-store" },
	);
}

export function searchRemoteSessions(
	token: string,
	projectId: string,
	query: string,
	limit = 24,
) {
	const params = new URLSearchParams({
		projectId,
		query,
		limit: String(limit),
	});
	return remoteFetch<SessionSearchMatch[]>(
		token,
		`/api/v1/sessions/search?${params.toString()}`,
	);
}

export function loadRemoteSessionReadStates(token: string) {
	return remoteFetch<SessionReadState[]>(token, "/api/v1/sessions/read-state", {
		cache: "no-store",
	});
}

export function markRemoteSessionRead(
	token: string,
	projectId: string,
	sessionPath: string,
	revision: number,
) {
	return remoteFetch<SessionReadState>(token, "/api/v1/sessions/read-state", {
		method: "POST",
		body: JSON.stringify({ projectId, sessionPath, revision }),
	});
}

export function loadRemoteExternalActivity(token: string, projectId: string) {
	const query = new URLSearchParams({ projectId });
	return remoteFetch<SessionExternalActivity[]>(
		token,
		`/api/v1/sessions/external-activity?${query.toString()}`,
	);
}

export function loadRemoteModels(token: string, projectId: string) {
	const query = new URLSearchParams({ projectId });
	return remoteFetch<ProjectPiModels | null>(
		token,
		`/api/v1/models?${query.toString()}`,
	);
}

export function saveRemoteModels(token: string, snapshot: ProjectPiModels) {
	return remoteFetch<ProjectPiModels>(token, "/api/v1/models", {
		method: "POST",
		body: JSON.stringify(snapshot),
	});
}

export function loadRemoteModelScope(token: string, projectId: string) {
	const query = new URLSearchParams({ projectId });
	return remoteFetch<ProjectModelScope>(
		token,
		`/api/v1/models/scope?${query.toString()}`,
	);
}

export function saveRemoteModelScope(
	token: string,
	projectId: string,
	models: ProjectScopedModel[] | null,
) {
	return remoteFetch<ProjectModelScope>(token, "/api/v1/models/scope", {
		method: "POST",
		body: JSON.stringify({ projectId, models }),
	});
}

export function loadRemoteCacheKeepAliveSettings(
	token: string,
	connectionId: string,
) {
	const query = new URLSearchParams({ connectionId });
	return remoteFetch<CacheKeepAliveSettings[]>(
		token,
		`/api/v1/cache-keep-alive/settings?${query.toString()}`,
	);
}

export function saveRemoteCacheKeepAliveSettings(
	token: string,
	settings: CacheKeepAliveSettings,
) {
	return remoteFetch<CacheKeepAliveSettings>(
		token,
		"/api/v1/cache-keep-alive/settings",
		{
			method: "POST",
			body: JSON.stringify(settings),
		},
	);
}

export function loadRemoteNextPromptSettings(
	token: string,
	connectionId: string,
) {
	const query = new URLSearchParams({ connectionId });
	return remoteFetch<NextPromptSettings>(
		token,
		`/api/v1/next-prompt/settings?${query.toString()}`,
	);
}

export function saveRemoteNextPromptSettings(
	token: string,
	connectionId: string,
	enabled: boolean,
	model: NextPromptModel | null,
) {
	return remoteFetch<NextPromptSettings>(
		token,
		"/api/v1/next-prompt/settings",
		{
			method: "POST",
			body: JSON.stringify({ connectionId, enabled, model }),
		},
	);
}

export function requestRemoteNextPrompt(
	token: string,
	request: NextPromptRequest,
) {
	return remoteFetch<void>(token, "/api/v1/next-prompt/request", {
		method: "POST",
		body: JSON.stringify(request),
	});
}

export function loadRemotePromptEnhancementSettings(
	token: string,
	connectionId: string,
) {
	const query = new URLSearchParams({ connectionId });
	return remoteFetch<PromptEnhancementSettings>(
		token,
		`/api/v1/prompt-enhancement/settings?${query.toString()}`,
	);
}

export function saveRemotePromptEnhancementSettings(
	token: string,
	connectionId: string,
	enabled: boolean,
	model: PromptEnhancementModel | null,
) {
	return remoteFetch<PromptEnhancementSettings>(
		token,
		"/api/v1/prompt-enhancement/settings",
		{
			method: "POST",
			body: JSON.stringify({ connectionId, enabled, model }),
		},
	);
}

export function enhanceRemotePrompt(
	token: string,
	projectId: string,
	draft: string,
	model: PromptEnhancementModel | null,
) {
	return remoteFetch<string>(token, "/api/v1/prompt-enhancement/enhance", {
		method: "POST",
		body: JSON.stringify({ projectId, draft, model }),
	});
}

export function loadRemoteHistory(
	token: string,
	projectId: string,
	sessionPath: string,
	options?: PiloClientHistoryOptions,
) {
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
	return remoteFetch<SessionHistoryResult>(
		token,
		`/api/v1/history?${query.toString()}`,
	);
}

export function loadRemoteHistoryImage(
	token: string,
	projectId: string,
	sessionPath: string,
	imageId: string,
	fingerprint?: SessionHistoryFingerprint,
) {
	const query = new URLSearchParams({
		projectId,
		sessionPath,
		imageId,
	});
	if (fingerprint) {
		query.set("expectedFileSize", String(fingerprint.fileSize));
		query.set("expectedFileMtimeNs", fingerprint.fileMtimeNs);
	}
	return remoteFetchBytes(token, `/api/v1/history/image?${query.toString()}`);
}

export function loadRemoteProjectImage(
	token: string,
	projectId: string,
	path: string,
) {
	const query = new URLSearchParams({ projectId, path });
	return remoteFetchBytes(token, `/api/v1/files/image?${query.toString()}`);
}

export async function uploadRemoteChatFile(
	token: string,
	projectId: string,
	file: File,
) {
	const query = new URLSearchParams({ projectId, name: file.name });
	const path = await remoteFetch<string>(
		token,
		`/api/v1/chat/files?${query.toString()}`,
		{
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: file,
		},
	);
	return registerChatFile(path, () => {
		const cleanupQuery = new URLSearchParams({ projectId, path });
		return remoteFetch<void>(
			token,
			`/api/v1/chat/files?${cleanupQuery.toString()}`,
			{
				method: "DELETE",
			},
		);
	});
}

export function generateRemoteSessionTitle(
	token: string,
	projectId: string,
	message: string,
) {
	return remoteFetch<string | null>(token, "/api/v1/sessions/title", {
		method: "POST",
		body: JSON.stringify({ projectId, message }),
	});
}

export function deleteRemoteSession(
	token: string,
	projectId: string,
	sessionPath: string,
) {
	return remoteFetch<SessionDeleteResult>(token, "/api/v1/sessions/delete", {
		method: "POST",
		body: JSON.stringify({ projectId, sessionPath }),
	});
}

export function startRemoteChat(
	token: string,
	input: PiloClientStartChatInput,
) {
	return remoteFetch<PiSessionSnapshot>(token, "/api/v1/chat/start", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function stopRemoteChat(
	token: string,
	sessionKey: string,
	reason?: string,
) {
	return remoteFetch<void>(token, "/api/v1/chat/stop", {
		method: "POST",
		body: JSON.stringify({ sessionKey, reason }),
	});
}

export function loadRemoteChatState(token: string, sessionKey: string) {
	const query = new URLSearchParams({ sessionKey });
	return remoteFetch<ChatSessionRuntimeState | null>(
		token,
		`/api/v1/chat/state?${query.toString()}`,
	);
}

export function searchRemoteFiles(
	token: string,
	projectId: string,
	query: string,
) {
	const params = new URLSearchParams({ projectId, query });
	return remoteFetch<string[]>(
		token,
		`/api/v1/files/search?${params.toString()}`,
	);
}

export function sendRemoteChatCommand(
	token: string,
	sessionKey: string,
	command: Record<string, unknown>,
) {
	return remoteFetch<void>(token, "/api/v1/chat/rpc", {
		method: "POST",
		body: JSON.stringify({ sessionKey, command }),
	});
}

export function approveRemoteProjectMcpServer(
	token: string,
	projectId: string,
	serverName: string,
) {
	return remoteFetch<void>(token, "/api/v1/chat/mcp-approve", {
		method: "POST",
		body: JSON.stringify({ projectId, serverName }),
	});
}

export function connectRemoteEvents(
	token: string,
	after: number | undefined,
	onMessage: (message: PiloClientEventMessage) => void,
	onStatus: (connected: boolean) => void,
) {
	const url = new URL("/api/v1/events", window.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	if (after && after > 0) url.searchParams.set("after", String(after));
	const socket = new WebSocket(url, ["pilo", `pilo-token.${token}`]);
	let hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;
	let probeTimer: number | undefined;
	const clearProbe = () => {
		if (probeTimer !== undefined) window.clearTimeout(probeTimer);
		probeTimer = undefined;
	};
	const disconnected = () => {
		clearProbe();
		onStatus(false);
	};
	const reconnect = () => {
		disconnected();
		socket.close();
	};
	const handleVisibilityChange = () => {
		if (document.visibilityState === "hidden") {
			hiddenAt = Date.now();
			clearProbe();
			return;
		}
		const suspendedAt = hiddenAt;
		hiddenAt = null;
		if (
			suspendedAt === null ||
			Date.now() - suspendedAt < FOREGROUND_RESUME_MIN_HIDDEN_MS
		)
			return;
		if (
			socket.readyState !== WebSocket.OPEN &&
			socket.readyState !== WebSocket.CONNECTING
		) {
			disconnected();
			return;
		}
		// A healthy socket must not lose pending input assistance on foreground.
		probeTimer = window.setTimeout(reconnect, SOCKET_PROBE_TIMEOUT_MS);
		if (socket.readyState === WebSocket.CONNECTING) return;
		try {
			socket.send(JSON.stringify({ type: "ping" }));
		} catch {
			reconnect();
		}
	};
	socket.addEventListener("open", () => onStatus(true));
	socket.addEventListener("close", disconnected);
	socket.addEventListener("error", disconnected);
	socket.addEventListener("message", (event) => {
		try {
			const message: unknown = JSON.parse(String(event.data));
			// Any server frame proves this connection is still delivering messages.
			clearProbe();
			if (isRecord(message) && message.type === "pong") return;
			onMessage(message as PiloClientEventMessage);
		} catch {
			// Ignore malformed server frames. Reconnect/snapshot logic handles gaps.
		}
	});
	document.addEventListener("visibilitychange", handleVisibilityChange);
	return () => {
		document.removeEventListener("visibilitychange", handleVisibilityChange);
		clearProbe();
		socket.close();
	};
}
