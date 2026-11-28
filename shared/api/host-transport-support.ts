import {
	HOST_API_PROTOCOL_VERSION,
	HostApiError,
	type HostApiErrorCode,
	type HostApiErrorPayload,
	type TerminalEvent,
} from "@shared/api/host-methods";
import type { PiloClientEventOptions } from "@shared/api/pilo-client";
import type { RemoteScopes } from "@shared/api/remote-types";

export type HostCapabilities = {
	platform: string;
	wsl: boolean;
	methods: string[];
	methodsHash: string;
};

export type HostHelloMessage = {
	type: "hello";
	hostId: string;
	hostName: string;
	deviceId?: string;
	protocolVersion: string;
	scopes: RemoteScopes;
	latestSequence: number;
	capabilities: HostCapabilities;
};

export type HostTransportConnectionState =
	| "connecting"
	| "connected"
	| "reconnecting"
	| "offline"
	| "incompatible"
	| "unauthorized";

export type AbortSignalLike = {
	readonly aborted: boolean;
	addEventListener(type: "abort", listener: () => void): void;
	removeEventListener(type: "abort", listener: () => void): void;
};

export type AbortControllerLike = {
	readonly signal: AbortSignalLike;
	abort(): void;
};

export type HostCallOptions = {
	signal?: AbortSignalLike;
};

export type TerminalSubscriptionAck = number | HostApiError;

export interface HostEventStream {
	subscribeEvents(options: PiloClientEventOptions): () => void;
	subscribeTerminal(
		terminalId: string,
		listener: (event: TerminalEvent) => void,
		onSubscribed?: (ack: TerminalSubscriptionAck) => void,
	): () => void;
	subscribeAllTerminals?(listener: (event: TerminalEvent) => void): () => void;
	nextTerminalEvents?(max: number): Promise<TerminalEvent[]>;
	onHello?(listener: (hello: HostHelloMessage) => void): () => void;
	onConnectionState?(
		listener: (state: HostTransportConnectionState) => void,
	): () => void;
	reconnectNow?(): void;
}

export interface HostTransport {
	call<T>(method: string, params: unknown, opts?: HostCallOptions): Promise<T>;
	upload<T = unknown>(
		method: string,
		params: Record<string, string>,
		bytes: Uint8Array,
		opts?: HostCallOptions,
	): Promise<T>;
	download(
		method: string,
		params: Record<string, string>,
		opts?: HostCallOptions,
	): Promise<Uint8Array<ArrayBuffer>>;
	events(): HostEventStream;
	readonly closed?: boolean;
	readonly capabilities?: HostCapabilities | null;
	readonly reconnectsEvents?: boolean;
	dispose(): void;
}

export interface TokenStore {
	getToken(): string | null;
	setToken?(token: string): void;
	clearToken?(): void;
}

export interface CursorStore {
	getCursor(hostId: string): number;
	setCursor(hostId: string, sequence: number): void;
}

export interface NetworkSignals {
	isOnline?(): boolean;
	onOnline?(listener: () => void): () => void;
	onOffline?(listener: () => void): () => void;
	onForeground?(listener: () => void): () => void;
	onBackground?(listener: () => void): () => void;
}

export type FetchResponseLike = {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
};

export type FetchRequestInitLike = {
	method?: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array;
	cache?: string;
	signal?: AbortSignalLike;
};

export type FetchLike = (
	url: string,
	init?: FetchRequestInitLike,
) => Promise<FetchResponseLike>;

export type WebSocketLike = {
	readonly readyState: number;
	addEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void,
	): void;
	addEventListener(
		type: "error" | "close",
		listener: (event: unknown) => void,
	): void;
	removeEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void,
	): void;
	removeEventListener(
		type: "error" | "close",
		listener: (event: unknown) => void,
	): void;
	send(data: string): void;
	close(code?: number, reason?: string): void;
};

export type WebSocketFactory = (
	url: string,
	protocols?: string[],
) => WebSocketLike;

export type SchedulerLike = {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	now(): number;
};

export type HttpTransportOptions = {
	origin: string;
	/** Optional known hostId before the first hello arrives. */
	hostId?: string;
	tokens: TokenStore;
	cursors?: CursorStore;
	network?: NetworkSignals;
	fetch?: FetchLike;
	createWebSocket?: WebSocketFactory;
	scheduler?: SchedulerLike;
	createAbortController?: () => AbortControllerLike;
	expectedMajorVersion?: number;
	reconnectDelaysMs?: readonly number[];
	probeTimeoutMs?: number;
	foregroundProbeMinHiddenMs?: number;
	cursorFlushDelayMs?: number;
	onUnauthorized?: () => void;
	onIncompatibleProtocol?: (hostVersion: string, clientVersion: string) => void;
};

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;

export const DEFAULT_RECONNECT_DELAYS_MS = [
	500, 1_000, 2_000, 4_000, 8_000, 15_000,
];
export const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
export const DEFAULT_FOREGROUND_PROBE_MIN_HIDDEN_MS = 5_000;
export const DEFAULT_CURSOR_FLUSH_DELAY_MS = 1_000;
export const HELLO_TIMEOUT_MS = 15_000;
export const HTTP_TIMEOUT_MS = {
	json: 50_000,
	upload: 60_000,
	download: 60_000,
};
export const LONG_HTTP_METHODS = new Set([
	"chat.start",
	"promptEnhancement.enhance",
	"session.title",
]);

export function abortError(): Error {
	const error = new Error("Host request aborted");
	error.name = "AbortError";
	return error;
}

export class MemoryCursorStore implements CursorStore {
	private readonly cursors = new Map<string, number>();

	getCursor(hostId: string): number {
		return this.cursors.get(hostId) ?? 0;
	}

	setCursor(hostId: string, sequence: number): void {
		this.cursors.set(hostId, Math.max(0, Math.floor(sequence)));
	}
}

export function parseMajorVersion(version: string): number | null {
	const trimmed = version.trim();
	const dot = trimmed.indexOf(".");
	const head = dot === -1 ? trimmed : trimmed.slice(0, dot);
	if (!/^\d+$/.test(head)) return null;
	return Number(head);
}

export function isCompatibleProtocolVersion(
	hostVersion: string,
	expectedMajor = parseMajorVersion(HOST_API_PROTOCOL_VERSION) ?? 2,
): boolean {
	const major = parseMajorVersion(hostVersion);
	return major !== null && major === expectedMajor;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isErrorCode(value: unknown): value is HostApiErrorCode {
	return (
		value === "unauthorized" ||
		value === "forbidden" ||
		value === "not_found" ||
		value === "invalid_params" ||
		value === "unavailable" ||
		value === "timeout" ||
		value === "internal" ||
		value === "conflict" ||
		value === "outcome_unknown"
	);
}

export function parseErrorPayload(value: unknown): HostApiErrorPayload | null {
	if (!isRecord(value)) return null;
	if (!isErrorCode(value.code) || typeof value.message !== "string") {
		return null;
	}
	return {
		code: value.code,
		message: value.message,
		retryable: Boolean(value.retryable),
	};
}

export function defaultScheduler(): SchedulerLike {
	const g = globalThis as unknown as {
		setTimeout: (cb: () => void, ms: number) => unknown;
		clearTimeout: (handle: unknown) => void;
	};
	return {
		setTimeout: (cb, ms) => g.setTimeout(cb, ms),
		clearTimeout: (handle) => g.clearTimeout(handle),
		now: () => Date.now(),
	};
}

export function defaultCreateAbortController(): () => AbortControllerLike {
	const g = globalThis as unknown as {
		AbortController?: new () => AbortControllerLike;
	};
	const Ctor = g.AbortController;
	if (typeof Ctor !== "function") {
		throw new HostApiError(
			"unavailable",
			"Global AbortController is not available in this environment",
			false,
		);
	}
	return () => new Ctor();
}

export function defaultFetch(): FetchLike {
	const g = globalThis as unknown as { fetch?: FetchLike };
	if (typeof g.fetch !== "function") {
		throw new HostApiError(
			"unavailable",
			"Global fetch is not available in this environment",
			false,
		);
	}
	return g.fetch.bind(globalThis);
}

export function defaultCreateWebSocket(): WebSocketFactory {
	const g = globalThis as unknown as {
		WebSocket?: new (url: string, protocols?: string[]) => WebSocketLike;
	};
	const Ctor = g.WebSocket;
	if (typeof Ctor !== "function") {
		throw new HostApiError(
			"unavailable",
			"Global WebSocket is not available in this environment",
			false,
		);
	}
	return (url, protocols) => new Ctor(url, protocols);
}

export function trimTrailingSlash(origin: string): string {
	return origin.replace(/\/+$/, "");
}

export function encodeQuery(params: Record<string, string>): string {
	const entries = Object.entries(params);
	if (entries.length === 0) return "";
	return entries
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");
}

export function toWebSocketUrl(
	origin: string,
	path: string,
	query: Record<string, string>,
): string {
	const base = trimTrailingSlash(origin);
	let wsBase: string;
	if (base.startsWith("https://")) {
		wsBase = `wss://${base.slice("https://".length)}`;
	} else if (base.startsWith("http://")) {
		wsBase = `ws://${base.slice("http://".length)}`;
	} else {
		wsBase = base;
	}
	const qs = encodeQuery(query);
	return qs ? `${wsBase}${path}?${qs}` : `${wsBase}${path}`;
}

export function parseTerminalEvent(
	parsed: Record<string, unknown>,
): TerminalEvent | null {
	if (parsed.type !== "terminal" || typeof parsed.terminalId !== "string") {
		return null;
	}
	if (parsed.event === "output" && typeof parsed.data === "string") {
		return {
			type: "output",
			terminalId: parsed.terminalId,
			data: parsed.data,
			...(typeof parsed.startOffset === "number"
				? { startOffset: parsed.startOffset }
				: {}),
		};
	}
	if (parsed.event === "exit") {
		return { type: "exit", terminalId: parsed.terminalId };
	}
	if (parsed.event === "error" && typeof parsed.message === "string") {
		return {
			type: "error",
			terminalId: parsed.terminalId,
			message: parsed.message,
		};
	}
	return null;
}

export function ignoreSocketError(): void {
	// Let close handle teardown and backoff.
}

export function statusToErrorCode(status: number): HostApiErrorCode {
	if (status === 401) return "unauthorized";
	if (status === 403) return "forbidden";
	if (status === 404) return "not_found";
	if (status === 408) return "timeout";
	if (status === 503) return "unavailable";
	if (status >= 400 && status < 500) return "invalid_params";
	return "internal";
}
