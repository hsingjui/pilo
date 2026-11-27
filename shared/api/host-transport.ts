import {
	HOST_API_PROTOCOL_VERSION,
	HostApiError,
	type HostApiErrorCode,
	type HostApiErrorPayload,
	type TerminalEvent,
} from "@shared/api/host-methods";
import type {
	PiloClientEventMessage,
	PiloClientEventOptions,
} from "@shared/api/pilo-client";
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
};

export type HostCallOptions = {
	signal?: AbortSignalLike;
};

export interface HostEventStream {
	subscribeEvents(options: PiloClientEventOptions): () => void;
	subscribeTerminal(
		terminalId: string,
		listener: (event: TerminalEvent) => void,
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
	expectedMajorVersion?: number;
	reconnectDelaysMs?: readonly number[];
	probeTimeoutMs?: number;
	foregroundProbeMinHiddenMs?: number;
	cursorFlushDelayMs?: number;
	onUnauthorized?: () => void;
	onIncompatibleProtocol?: (hostVersion: string, clientVersion: string) => void;
};

const WS_CONNECTING = 0;
const WS_OPEN = 1;

const DEFAULT_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_FOREGROUND_PROBE_MIN_HIDDEN_MS = 5_000;
const DEFAULT_CURSOR_FLUSH_DELAY_MS = 1_000;

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(value: unknown): value is HostApiErrorCode {
	return (
		value === "unauthorized" ||
		value === "forbidden" ||
		value === "not_found" ||
		value === "invalid_params" ||
		value === "unavailable" ||
		value === "timeout" ||
		value === "internal"
	);
}

function parseErrorPayload(value: unknown): HostApiErrorPayload | null {
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

function defaultScheduler(): SchedulerLike {
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

function defaultFetch(): FetchLike {
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

function defaultCreateWebSocket(): WebSocketFactory {
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

function trimTrailingSlash(origin: string): string {
	return origin.replace(/\/+$/, "");
}

function encodeQuery(params: Record<string, string>): string {
	const entries = Object.entries(params);
	if (entries.length === 0) return "";
	return entries
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");
}

function toWebSocketUrl(
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

function parseTerminalEvent(
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

function ignoreSocketError(): void {
	// Let close handle teardown and backoff.
}

function statusToErrorCode(status: number): HostApiErrorCode {
	if (status === 401) return "unauthorized";
	if (status === 403) return "forbidden";
	if (status === 404) return "not_found";
	if (status === 408) return "timeout";
	if (status === 503) return "unavailable";
	if (status >= 400 && status < 500) return "invalid_params";
	return "internal";
}

export class HttpTransport implements HostTransport {
	private readonly origin: string;
	private readonly tokens: TokenStore;
	private readonly cursors: CursorStore;
	private readonly network: NetworkSignals | undefined;
	private readonly fetchFn: FetchLike;
	private readonly createWebSocketFn: WebSocketFactory;
	private readonly scheduler: SchedulerLike;
	private readonly expectedMajor: number;
	private readonly reconnectDelaysMs: readonly number[];
	private readonly probeTimeoutMs: number;
	private readonly foregroundProbeMinHiddenMs: number;
	private readonly cursorFlushDelayMs: number;
	private readonly onUnauthorized: (() => void) | undefined;
	private readonly onIncompatibleProtocol:
		| ((hostVersion: string, clientVersion: string) => void)
		| undefined;

	private disposed = false;
	private hostId: string | null;
	private latestCapabilities: HostCapabilities | null = null;
	private latestHello: HostHelloMessage | null = null;
	private connectionState: HostTransportConnectionState = "connecting";
	private replayCursor = 0;
	private persistedCursor: number | undefined;
	private cursorFlushTimer: unknown;

	private socket: WebSocketLike | null = null;
	private socketCursorHostId: string | null = null;
	private socketCursorSent = 0;
	private detachSocketListeners: (() => void) | undefined;
	private socketReady = false;
	private reconnectAttempts = 0;
	private reconnectTimer: unknown;
	private probeTimer: unknown;
	private hiddenAt: number | null = null;
	private online = true;
	private removeNetworkListeners: (() => void) | undefined;

	private readonly eventListeners = new Set<PiloClientEventOptions>();
	private readonly terminalListeners = new Map<
		string,
		Set<(event: TerminalEvent) => void>
	>();
	private readonly allTerminalListeners = new Set<
		(event: TerminalEvent) => void
	>();
	private readonly helloListeners = new Set<
		(hello: HostHelloMessage) => void
	>();
	private readonly stateListeners = new Set<
		(state: HostTransportConnectionState) => void
	>();
	private readonly stream: HostEventStream;

	constructor(options: HttpTransportOptions) {
		this.origin = trimTrailingSlash(options.origin);
		this.hostId = options.hostId ?? null;
		this.tokens = options.tokens;
		this.cursors = options.cursors ?? new MemoryCursorStore();
		this.network = options.network;
		this.fetchFn = options.fetch ?? defaultFetch();
		this.createWebSocketFn =
			options.createWebSocket ?? defaultCreateWebSocket();
		this.scheduler = options.scheduler ?? defaultScheduler();
		this.expectedMajor =
			options.expectedMajorVersion ??
			parseMajorVersion(HOST_API_PROTOCOL_VERSION) ??
			2;
		this.reconnectDelaysMs =
			options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
		this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
		this.foregroundProbeMinHiddenMs =
			options.foregroundProbeMinHiddenMs ??
			DEFAULT_FOREGROUND_PROBE_MIN_HIDDEN_MS;
		this.cursorFlushDelayMs =
			options.cursorFlushDelayMs ?? DEFAULT_CURSOR_FLUSH_DELAY_MS;
		this.onUnauthorized = options.onUnauthorized;
		this.onIncompatibleProtocol = options.onIncompatibleProtocol;
		this.online = options.network?.isOnline?.() ?? true;

		if (this.hostId) {
			this.replayCursor = Math.max(0, this.cursors.getCursor(this.hostId));
			this.persistedCursor = this.replayCursor;
		}

		this.bindNetworkSignals();

		this.stream = {
			subscribeEvents: (opts) => this.subscribeEvents(opts),
			subscribeTerminal: (terminalId, listener) =>
				this.subscribeTerminal(terminalId, listener),
			subscribeAllTerminals: (listener) => this.subscribeAllTerminals(listener),
			onHello: (listener) => this.onHello(listener),
			onConnectionState: (listener) => this.onConnectionState(listener),
			reconnectNow: () => this.reconnectNow(),
		};
	}

	get closed(): boolean {
		return this.disposed;
	}

	get capabilities(): HostCapabilities | null {
		return this.latestCapabilities;
	}

	get currentHostId(): string | null {
		return this.hostId;
	}

	get currentState(): HostTransportConnectionState {
		return this.connectionState;
	}

	events(): HostEventStream {
		return this.stream;
	}

	async call<T>(
		method: string,
		params: unknown,
		opts?: HostCallOptions,
	): Promise<T> {
		this.assertOpen();
		const token = this.requireToken();
		const url = `${this.origin}/api/v2/call/${encodeURIComponent(method)}`;
		const response = await this.fetchFn(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(params ?? {}),
			cache: "no-store",
			signal: opts?.signal,
		});
		return this.parseEnvelopeResponse<T>(response);
	}

	async upload<T = unknown>(
		method: string,
		params: Record<string, string>,
		bytes: Uint8Array,
		opts?: HostCallOptions,
	): Promise<T> {
		this.assertOpen();
		const token = this.requireToken();
		const qs = encodeQuery(params);
		const path = `/api/v2/upload/${encodeURIComponent(method)}`;
		const url = qs ? `${this.origin}${path}?${qs}` : `${this.origin}${path}`;
		const response = await this.fetchFn(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/octet-stream",
			},
			body: new Uint8Array(bytes),
			cache: "no-store",
			signal: opts?.signal,
		});
		return this.parseEnvelopeResponse<T>(response);
	}

	async download(
		method: string,
		params: Record<string, string>,
		opts?: HostCallOptions,
	): Promise<Uint8Array<ArrayBuffer>> {
		this.assertOpen();
		const token = this.requireToken();
		const qs = encodeQuery(params);
		const path = `/api/v2/blob/${encodeURIComponent(method)}`;
		const url = qs ? `${this.origin}${path}?${qs}` : `${this.origin}${path}`;
		const response = await this.fetchFn(url, {
			method: "GET",
			headers: {
				authorization: `Bearer ${token}`,
			},
			signal: opts?.signal,
		});
		if (!response.ok) {
			await this.throwHttpError(response);
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	reconnectNow(): void {
		if (
			this.disposed ||
			this.connectionState === "incompatible" ||
			this.connectionState === "unauthorized"
		) {
			return;
		}
		this.reconnectAttempts = 0;
		this.clearReconnectTimer();
		this.clearProbeTimer();
		this.setState(this.online ? "reconnecting" : "offline");
		if (this.socket) {
			this.closeSocketOnly();
			this.notifyEventStatus(false);
		}
		this.ensureSocket();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.flushCursor();
		this.clearReconnectTimer();
		this.clearProbeTimer();
		this.removeNetworkListeners?.();
		this.removeNetworkListeners = undefined;
		this.closeSocketOnly();
		const active = [...this.eventListeners];
		this.eventListeners.clear();
		this.terminalListeners.clear();
		this.allTerminalListeners.clear();
		this.helloListeners.clear();
		this.stateListeners.clear();
		for (const listener of active) {
			listener.onStatus(false);
		}
	}

	private assertOpen(): void {
		if (this.disposed) {
			throw new HostApiError(
				"unavailable",
				"Host transport has been disposed",
				false,
			);
		}
	}

	private requireToken(): string {
		const token = this.tokens.getToken();
		if (!token) {
			this.setState("unauthorized");
			this.onUnauthorized?.();
			throw new HostApiError(
				"unauthorized",
				"Missing remote device authentication token",
				false,
			);
		}
		return token;
	}

	private async parseEnvelopeResponse<T>(
		response: FetchResponseLike,
	): Promise<T> {
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			if (!response.ok) {
				await this.throwHttpError(response);
			}
			throw new HostApiError("internal", "Invalid JSON response from Host");
		}
		if (isRecord(body) && body.ok === true) {
			return body.result as T;
		}
		if (isRecord(body) && body.ok === false) {
			const payload = parseErrorPayload(body.error);
			if (payload) {
				if (payload.code === "unauthorized") {
					this.setState("unauthorized");
					this.onUnauthorized?.();
				}
				throw HostApiError.fromPayload(payload);
			}
		}
		if (response.status === 401) {
			this.setState("unauthorized");
			this.onUnauthorized?.();
		}
		const message =
			isRecord(body) && typeof body.error === "string"
				? body.error
				: `Host request failed (${response.status})`;
		throw new HostApiError(
			statusToErrorCode(response.status),
			message,
			response.status === 503 || response.status === 408,
		);
	}

	private async throwHttpError(response: FetchResponseLike): Promise<never> {
		if (response.status === 401) {
			this.setState("unauthorized");
			this.onUnauthorized?.();
		}
		let message = `Host request failed (${response.status})`;
		try {
			const parsed = await response.json();
			if (isRecord(parsed)) {
				const err = parseErrorPayload(parsed.error);
				if (err) throw HostApiError.fromPayload(err);
				if (typeof parsed.error === "string") message = parsed.error;
			}
		} catch (error) {
			if (error instanceof HostApiError) throw error;
		}
		throw new HostApiError(
			statusToErrorCode(response.status),
			message,
			response.status === 503 || response.status === 408,
		);
	}

	private subscribeEvents(options: PiloClientEventOptions): () => void {
		if (this.disposed) {
			options.onStatus(false);
			return () => undefined;
		}
		if (
			typeof options.after === "number" &&
			options.after > this.replayCursor
		) {
			this.replayCursor = options.after;
		}
		this.eventListeners.add(options);
		if (this.socketReady && this.socket?.readyState === WS_OPEN) {
			options.onStatus(true);
		}
		this.ensureSocket();
		return () => {
			this.eventListeners.delete(options);
			if (!this.hasAnyStreamSubscribers()) {
				this.closeSocketOnly();
			}
		};
	}

	private subscribeTerminal(
		terminalId: string,
		listener: (event: TerminalEvent) => void,
	): () => void {
		if (this.disposed) return () => undefined;
		let set = this.terminalListeners.get(terminalId);
		const isFirst = !set;
		if (!set) {
			set = new Set();
			this.terminalListeners.set(terminalId, set);
		}
		set.add(listener);
		this.ensureSocket();
		if (isFirst && this.socketReady && this.socket?.readyState === WS_OPEN) {
			this.sendSocketJson({ type: "terminal.subscribe", terminalId });
		}
		return () => {
			const listeners = this.terminalListeners.get(terminalId);
			if (!listeners) return;
			listeners.delete(listener);
			if (listeners.size === 0) {
				this.terminalListeners.delete(terminalId);
				if (this.socketReady && this.socket?.readyState === WS_OPEN) {
					this.sendSocketJson({ type: "terminal.unsubscribe", terminalId });
				}
			}
			if (!this.hasAnyStreamSubscribers()) {
				this.closeSocketOnly();
			}
		};
	}

	private subscribeAllTerminals(
		listener: (event: TerminalEvent) => void,
	): () => void {
		if (this.disposed) return () => undefined;
		this.allTerminalListeners.add(listener);
		this.ensureSocket();
		return () => {
			this.allTerminalListeners.delete(listener);
			if (!this.hasAnyStreamSubscribers()) {
				this.closeSocketOnly();
			}
		};
	}

	private onHello(listener: (hello: HostHelloMessage) => void): () => void {
		this.helloListeners.add(listener);
		if (this.latestHello) {
			listener(this.latestHello);
		}
		return () => {
			this.helloListeners.delete(listener);
		};
	}

	private onConnectionState(
		listener: (state: HostTransportConnectionState) => void,
	): () => void {
		this.stateListeners.add(listener);
		listener(this.connectionState);
		return () => {
			this.stateListeners.delete(listener);
		};
	}

	private hasAnyStreamSubscribers(): boolean {
		return (
			this.eventListeners.size > 0 ||
			this.terminalListeners.size > 0 ||
			this.allTerminalListeners.size > 0
		);
	}

	private bindNetworkSignals(): void {
		const net = this.network;
		if (!net) return;
		const cleanups: (() => void)[] = [];
		if (net.onOnline) {
			cleanups.push(
				net.onOnline(() => {
					this.online = true;
					if (!this.disposed && this.hasAnyStreamSubscribers()) {
						this.reconnectNow();
					}
				}),
			);
		}
		if (net.onOffline) {
			cleanups.push(
				net.onOffline(() => {
					this.online = false;
					this.setState("offline");
				}),
			);
		}
		if (net.onBackground) {
			cleanups.push(
				net.onBackground(() => {
					this.hiddenAt = this.scheduler.now();
					this.flushCursor();
					this.clearProbeTimer();
				}),
			);
		}
		if (net.onForeground) {
			cleanups.push(
				net.onForeground(() => {
					this.handleForeground();
				}),
			);
		}
		this.removeNetworkListeners = () => {
			for (const cleanup of cleanups) cleanup();
		};
	}

	private handleForeground(): void {
		if (this.disposed) return;
		const suspendedAt = this.hiddenAt;
		this.hiddenAt = null;
		if (this.reconnectTimer !== undefined && this.online) {
			this.reconnectNow();
			return;
		}
		if (
			suspendedAt === null ||
			this.scheduler.now() - suspendedAt < this.foregroundProbeMinHiddenMs
		) {
			return;
		}
		if (!this.hasAnyStreamSubscribers()) return;
		const socket = this.socket;
		if (
			!socket ||
			(socket.readyState !== WS_OPEN && socket.readyState !== WS_CONNECTING)
		) {
			this.reconnectNow();
			return;
		}
		this.clearProbeTimer();
		this.probeTimer = this.scheduler.setTimeout(() => {
			this.probeTimer = undefined;
			this.reconnectNow();
		}, this.probeTimeoutMs);
		if (socket.readyState === WS_OPEN) {
			try {
				socket.send(JSON.stringify({ type: "ping" }));
			} catch {
				this.reconnectNow();
			}
		}
	}

	private ensureSocket(): void {
		if (
			this.disposed ||
			this.socket ||
			this.reconnectTimer !== undefined ||
			this.connectionState === "incompatible" ||
			this.connectionState === "unauthorized"
		) {
			return;
		}
		this.openSocket();
	}

	private openSocket(): void {
		if (this.disposed || !this.hasAnyStreamSubscribers()) return;
		const token = this.tokens.getToken();
		if (!token) {
			this.setState("unauthorized");
			this.onUnauthorized?.();
			return;
		}
		this.clearReconnectTimer();
		this.clearProbeTimer();
		this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");

		const cursorToSend = this.replayCursor;
		const cursorHostId = this.hostId;
		const url = toWebSocketUrl(this.origin, "/api/v2/events", {
			after: String(cursorToSend),
		});

		let socket: WebSocketLike;
		try {
			socket = this.createWebSocketFn(url, ["pilo", `pilo-token.${token}`]);
		} catch {
			this.notifyEventStatus(false);
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;
		this.socketCursorHostId = cursorHostId;
		this.socketCursorSent = cursorToSend;

		const handleMessage = (event: { data: unknown }) => {
			if (this.socket !== socket || this.disposed) return;
			this.clearProbeTimer();
			try {
				const parsed: unknown = JSON.parse(String(event.data));
				if (!isRecord(parsed)) return;
				if (parsed.type === "pong") return;

				if (parsed.type === "hello") {
					this.handleHello(socket, parsed);
					return;
				}

				const terminalEvent = parseTerminalEvent(parsed);
				if (terminalEvent) {
					this.broadcastTerminalEvent(terminalEvent);
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
				this.broadcastEventMessage(parsed as PiloClientEventMessage);
				if (this.socket === socket) {
					this.setReplayCursor(consumed);
				}
			} catch {
				// Ignore malformed frames; reconnect/resync handles recovery.
			}
		};

		const handleClose = () => {
			if (this.socket !== socket) return;
			this.closeSocketOnly();
			this.clearProbeTimer();
			if (
				this.disposed ||
				!this.hasAnyStreamSubscribers() ||
				this.connectionState === "incompatible" ||
				this.connectionState === "unauthorized"
			) {
				return;
			}
			this.setState(this.online ? "reconnecting" : "offline");
			this.notifyEventStatus(false);
			this.scheduleReconnect();
		};

		socket.addEventListener("message", handleMessage);
		socket.addEventListener("error", ignoreSocketError);
		socket.addEventListener("close", handleClose);
		this.detachSocketListeners = () => {
			socket.removeEventListener("message", handleMessage);
			socket.removeEventListener("error", ignoreSocketError);
			socket.removeEventListener("close", handleClose);
		};
	}

	private handleHello(
		socket: WebSocketLike,
		parsed: Record<string, unknown>,
	): void {
		const protocolVersion =
			typeof parsed.protocolVersion === "string" ? parsed.protocolVersion : "";
		if (!isCompatibleProtocolVersion(protocolVersion, this.expectedMajor)) {
			this.setState("incompatible");
			this.closeSocketOnly();
			this.notifyEventStatus(false);
			this.onIncompatibleProtocol?.(protocolVersion, HOST_API_PROTOCOL_VERSION);
			return;
		}

		const incomingHostId =
			typeof parsed.hostId === "string" && parsed.hostId.length > 0
				? parsed.hostId
				: this.hostId;
		if (incomingHostId && incomingHostId !== this.socketCursorHostId) {
			this.hostId = incomingHostId;
			const stored = Math.max(0, this.cursors.getCursor(incomingHostId));
			this.replayCursor = stored;
			this.persistedCursor = stored;
			if (stored !== this.socketCursorSent) {
				this.closeSocketOnly();
				this.openSocket();
				return;
			}
		}

		const latestSequence =
			typeof parsed.latestSequence === "number" ? parsed.latestSequence : 0;
		const regressed = latestSequence < this.replayCursor;
		if (regressed) {
			this.setReplayCursor(0, true);
		}

		const hello = parsed as unknown as HostHelloMessage;
		this.latestHello = hello;
		this.latestCapabilities = hello.capabilities ?? null;
		this.socketReady = true;
		this.reconnectAttempts = 0;
		this.setState("connected");
		this.notifyEventStatus(true);

		for (const listener of this.helloListeners) {
			listener(hello);
		}
		this.broadcastEventMessage({
			type: "hello",
			latestSequence,
			deviceId: hello.deviceId,
		});
		if (regressed) {
			this.broadcastEventMessage({
				type: "resyncRequired",
				latestSequence,
			});
		}

		// Re-subscribe any active terminal streams on this socket.
		if (this.socket === socket && socket.readyState === WS_OPEN) {
			for (const terminalId of this.terminalListeners.keys()) {
				this.sendSocketJson({ type: "terminal.subscribe", terminalId });
			}
		}
	}

	private sendSocketJson(payload: unknown): void {
		if (!this.socket || this.socket.readyState !== WS_OPEN) return;
		try {
			this.socket.send(JSON.stringify(payload));
		} catch {
			// Reconnect handles socket errors.
		}
	}

	private broadcastEventMessage(message: PiloClientEventMessage): void {
		for (const listener of Array.from(this.eventListeners)) {
			listener.onMessage(message);
		}
	}

	private broadcastTerminalEvent(event: TerminalEvent): void {
		const targeted = this.terminalListeners.get(event.terminalId);
		if (targeted) {
			for (const listener of Array.from(targeted)) {
				listener(event);
			}
		}
		for (const listener of Array.from(this.allTerminalListeners)) {
			listener(event);
		}
	}

	private notifyEventStatus(connected: boolean): void {
		for (const listener of Array.from(this.eventListeners)) {
			listener.onStatus(connected);
		}
	}

	private setState(state: HostTransportConnectionState): void {
		if (this.connectionState === state) return;
		this.connectionState = state;
		for (const listener of Array.from(this.stateListeners)) {
			listener(state);
		}
	}

	private setReplayCursor(sequence: number, immediate = false): void {
		if (sequence === this.replayCursor && !immediate) return;
		this.replayCursor = sequence;
		if (immediate) {
			this.flushCursor();
			return;
		}
		if (this.cursorFlushTimer === undefined) {
			this.cursorFlushTimer = this.scheduler.setTimeout(() => {
				this.cursorFlushTimer = undefined;
				this.flushCursor();
			}, this.cursorFlushDelayMs);
		}
	}

	private flushCursor(): void {
		if (this.cursorFlushTimer !== undefined) {
			this.scheduler.clearTimeout(this.cursorFlushTimer);
			this.cursorFlushTimer = undefined;
		}
		if (!this.hostId) return;
		if (this.persistedCursor === this.replayCursor) return;
		this.persistedCursor = this.replayCursor;
		this.cursors.setCursor(this.hostId, this.replayCursor);
	}

	private scheduleReconnect(): void {
		if (
			this.disposed ||
			!this.hasAnyStreamSubscribers() ||
			this.reconnectTimer !== undefined
		) {
			return;
		}
		const index = Math.min(
			this.reconnectAttempts,
			Math.max(0, this.reconnectDelaysMs.length - 1),
		);
		const delay = this.reconnectDelaysMs[index] ?? 1_000;
		this.reconnectAttempts += 1;
		this.reconnectTimer = this.scheduler.setTimeout(() => {
			this.reconnectTimer = undefined;
			this.openSocket();
		}, delay);
	}

	private closeSocketOnly(): void {
		const socket = this.socket;
		this.socket = null;
		this.socketReady = false;
		this.detachSocketListeners?.();
		this.detachSocketListeners = undefined;
		if (!socket) return;
		try {
			socket.close();
		} catch {
			// Ignore close errors.
		}
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer !== undefined) {
			this.scheduler.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
	}

	private clearProbeTimer(): void {
		if (this.probeTimer !== undefined) {
			this.scheduler.clearTimeout(this.probeTimer);
			this.probeTimer = undefined;
		}
	}
}
