import type { ChatSessionRuntimeState } from "@/lib/chat-session-client";
import type {
	PiloClientBootstrap,
	PiloClientEventMessage,
	PiloClientHistoryOptions,
	PiloClientStartChatInput,
} from "@/lib/pilo-client";
import type {
	PiModel,
	PiSessionSnapshot,
	PiThinkingLevel,
} from "@/lib/pi-runtime";
import type {
	SessionHistoryFingerprint,
	SessionHistoryResult,
	SessionIndexEntry,
} from "@/lib/sessions";

export const REMOTE_TOKEN_KEY = "pilo.remote.device-token.v1";
export const REMOTE_SEQUENCE_KEY = "pilo.remote.sequence.v1";

async function decodeError(response: Response) {
	try {
		const body = (await response.json()) as { error?: string };
		return body.error || response.statusText;
	} catch {
		return response.statusText;
	}
}

export async function pairRemote(secret: string) {
	const response = await fetch("/api/v1/auth/pair", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			secret,
			deviceName: navigator.userAgent.slice(0, 80),
		}),
	});
	if (!response.ok) throw new Error(await decodeError(response));
	return (await response.json()) as {
		token: string;
		device: { id: string; name: string; expiresAtMs: number };
	};
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
		window.localStorage.removeItem(REMOTE_TOKEN_KEY);
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
		window.localStorage.removeItem(REMOTE_TOKEN_KEY);
		throw new Error("REMOTE_AUTH_EXPIRED");
	}
	if (!response.ok) throw new Error(await decodeError(response));
	return new Uint8Array(await response.arrayBuffer());
}

export function loadRemoteBootstrap(token: string) {
	return remoteFetch<PiloClientBootstrap>(token, "/api/v1/bootstrap");
}

export function loadRemoteSessions(token: string, projectId: string) {
	const query = new URLSearchParams({ projectId });
	return remoteFetch<SessionIndexEntry[]>(
		token,
		`/api/v1/sessions?${query.toString()}`,
	);
}

/** Mirror of the Desktop `ProjectPiModels` snapshot persisted in `project_model_cache`. */
export type RemoteProjectModels = {
	projectId: string;
	models: PiModel[];
	defaultModel: PiModel | null;
	defaultThinkingLevel: PiThinkingLevel | null;
	refreshedAtMs: number;
};

export function loadRemoteModels(token: string, projectId: string) {
	const query = new URLSearchParams({ projectId });
	return remoteFetch<RemoteProjectModels | null>(
		token,
		`/api/v1/models?${query.toString()}`,
	);
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

export function startRemoteChat(
	token: string,
	input: PiloClientStartChatInput,
) {
	return remoteFetch<PiSessionSnapshot>(token, "/api/v1/chat/start", {
		method: "POST",
		body: JSON.stringify(input),
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
	socket.addEventListener("open", () => onStatus(true));
	socket.addEventListener("close", () => onStatus(false));
	socket.addEventListener("error", () => onStatus(false));
	socket.addEventListener("message", (event) => {
		try {
			onMessage(JSON.parse(String(event.data)) as PiloClientEventMessage);
		} catch {
			// Ignore malformed server frames. Reconnect/snapshot logic handles gaps.
		}
	});
	return () => socket.close();
}
