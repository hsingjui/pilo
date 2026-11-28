import {
	HOST_API_PROTOCOL_VERSION,
	HostApiError,
	type TerminalEvent,
} from "@shared/api/host-methods";
import type {
	PiloClientEventMessage,
	PiloClientEventOptions,
} from "@shared/api/pilo-client";

export type {
	AbortSignalLike,
	CursorStore,
	FetchLike,
	FetchRequestInitLike,
	FetchResponseLike,
	HostCallOptions,
	HostCapabilities,
	HostEventStream,
	HostHelloMessage,
	HostTransport,
	HostTransportConnectionState,
	HttpTransportOptions,
	NetworkSignals,
	SchedulerLike,
	TerminalSubscriptionAck,
	TokenStore,
	WebSocketFactory,
	WebSocketLike,
} from "./host-transport-support";
export {
	MemoryCursorStore,
	isCompatibleProtocolVersion,
	parseMajorVersion,
} from "./host-transport-support";

import {
	type AbortControllerLike,
	type AbortSignalLike,
	type CursorStore,
	type FetchLike,
	type FetchResponseLike,
	type HostCallOptions,
	type SchedulerLike,
	type TokenStore,
	type WebSocketFactory,
	type WebSocketLike,
	type HostCapabilities,
	type HostEventStream,
	type HostHelloMessage,
	type HostTransport,
	type HostTransportConnectionState,
	type HttpTransportOptions,
	type NetworkSignals,
	type TerminalSubscriptionAck,
	MemoryCursorStore,
	isCompatibleProtocolVersion,
	parseMajorVersion,
	abortError,
	defaultCreateAbortController,
	defaultCreateWebSocket,
	defaultFetch,
	defaultScheduler,
	encodeQuery,
	ignoreSocketError,
	isRecord,
	parseErrorPayload,
	parseTerminalEvent,
	statusToErrorCode,
	toWebSocketUrl,
	trimTrailingSlash,
	DEFAULT_CURSOR_FLUSH_DELAY_MS,
	DEFAULT_FOREGROUND_PROBE_MIN_HIDDEN_MS,
	DEFAULT_PROBE_TIMEOUT_MS,
	DEFAULT_RECONNECT_DELAYS_MS,
	HELLO_TIMEOUT_MS,
	HTTP_TIMEOUT_MS,
	LONG_HTTP_METHODS,
	WS_CONNECTING,
	WS_OPEN,
} from "./host-transport-support";

export class HttpTransport implements HostTransport {
	private readonly origin: string;
	private readonly tokens: TokenStore;
	private readonly cursors: CursorStore;
	private readonly network: NetworkSignals | undefined;
	private readonly fetchFn: FetchLike;
	private readonly createWebSocketFn: WebSocketFactory;
	private readonly scheduler: SchedulerLike;
	private readonly createAbortController: () => AbortControllerLike;
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
	private negotiationError: HostApiError | undefined;
	private readonly helloWaiters = new Set<(error?: Error) => void>();
	private authProbe: Promise<void> | undefined;
	private connectionState: HostTransportConnectionState = "connecting";
	private replayCursor = 0;
	private persistedCursor: number | undefined;
	private cursorFlushTimer: unknown;

	private socket: WebSocketLike | null = null;
	private socketCursorHostId: string | null = null;
	private socketCursorSent = 0;
	private hostIdSwitchAttempted = false;
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
		Map<
			(event: TerminalEvent) => void,
			((ack: TerminalSubscriptionAck) => void) | undefined
		>
	>();
	private readonly terminalAcks = new Map<string, TerminalSubscriptionAck>();
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
	readonly reconnectsEvents = true;

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
		this.createAbortController =
			options.createAbortController ?? defaultCreateAbortController();
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
			subscribeTerminal: (terminalId, listener, onSubscribed) =>
				this.subscribeTerminal(terminalId, listener, onSubscribed),
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
		const url = `${this.origin}/api/v2/call/${encodeURIComponent(method)}`;
		return this.request(method, "json", opts, async (signal) => {
			const response = await this.fetchFn(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.requireToken()}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(params ?? {}),
				cache: "no-store",
				signal,
			});
			return this.parseEnvelopeResponse<T>(response);
		});
	}

	async upload<T = unknown>(
		method: string,
		params: Record<string, string>,
		bytes: Uint8Array,
		opts?: HostCallOptions,
	): Promise<T> {
		const qs = encodeQuery(params);
		const path = `/api/v2/upload/${encodeURIComponent(method)}`;
		const url = qs ? `${this.origin}${path}?${qs}` : `${this.origin}${path}`;
		return this.request(method, "upload", opts, async (signal) => {
			const response = await this.fetchFn(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.requireToken()}`,
					"content-type": "application/octet-stream",
				},
				body: new Uint8Array(bytes),
				cache: "no-store",
				signal,
			});
			return this.parseEnvelopeResponse<T>(response);
		});
	}

	async download(
		method: string,
		params: Record<string, string>,
		opts?: HostCallOptions,
	): Promise<Uint8Array<ArrayBuffer>> {
		const qs = encodeQuery(params);
		const path = `/api/v2/blob/${encodeURIComponent(method)}`;
		const url = qs ? `${this.origin}${path}?${qs}` : `${this.origin}${path}`;
		return this.request(method, "download", opts, async (signal) => {
			const response = await this.fetchFn(url, {
				method: "GET",
				headers: {
					authorization: `Bearer ${this.requireToken()}`,
				},
				signal,
			});
			if (!response.ok) await this.throwHttpError(response);
			return new Uint8Array(await response.arrayBuffer());
		});
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
		this.finishNegotiation(
			new HostApiError(
				"unavailable",
				"Host transport has been disposed",
				false,
			),
		);
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

	private async request<T>(
		method: string,
		kind: keyof typeof HTTP_TIMEOUT_MS,
		opts: HostCallOptions | undefined,
		run: (signal: AbortSignalLike | undefined) => Promise<T>,
	): Promise<T> {
		const signal = opts?.signal;
		const deadline = this.scheduler.now() + HELLO_TIMEOUT_MS;
		const check = () => {
			this.assertOpen();
			if (this.negotiationError) throw this.negotiationError;
			if (signal?.aborted) throw abortError();
		};
		check();
		while (!this.socketReady) {
			const remaining = deadline - this.scheduler.now();
			const timeout = new HostApiError(
				"timeout",
				"Timed out waiting for Host hello",
				true,
			);
			if (remaining <= 0) throw timeout;
			// oxlint-disable-next-line no-await-in-loop -- A negotiated socket can close before the waiter resumes.
			await new Promise<void>((resolve, reject) => {
				const cancel = () => finish(abortError());
				const finish = (error?: Error) => {
					this.helloWaiters.delete(finish);
					this.scheduler.clearTimeout(timer);
					signal?.removeEventListener("abort", cancel);
					if (error) reject(error);
					else resolve();
				};
				const timer = this.scheduler.setTimeout(
					() => finish(timeout),
					remaining,
				);
				this.helloWaiters.add(finish);
				signal?.addEventListener("abort", cancel);
				this.ensureSocket();
			});
			check();
		}
		if (
			this.latestCapabilities?.methods &&
			!this.latestCapabilities.methods.includes(method)
		) {
			throw new HostApiError(
				"not_found",
				`The connected Host does not support ${method}. Upgrade Pilo on the Host to use this feature.`,
				false,
			);
		}

		if (LONG_HTTP_METHODS.has(method)) return run(signal);
		const controller = this.createAbortController();
		let interrupt!: (error: Error) => void;
		const interrupted = new Promise<never>((_resolve, reject) => {
			interrupt = reject;
		});
		const stop = (error: Error) => {
			interrupt(error);
			controller.abort();
		};
		const cancel = () => stop(abortError());
		const timer = this.scheduler.setTimeout(
			() =>
				stop(
					new HostApiError(
						"timeout",
						`Host request timed out: ${method}`,
						true,
					),
				),
			HTTP_TIMEOUT_MS[kind],
		);
		signal?.addEventListener("abort", cancel);
		try {
			return await Promise.race([run(controller.signal), interrupted]);
		} finally {
			this.scheduler.clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
		}
	}

	private finishNegotiation(error?: HostApiError): void {
		this.negotiationError = error;
		for (const finish of this.helloWaiters) finish(error);
	}

	private markUnauthorized(): void {
		if (this.disposed || this.connectionState === "unauthorized") return;
		this.finishNegotiation(
			new HostApiError(
				"unauthorized",
				"Remote device authorization expired",
				false,
			),
		);
		this.clearReconnectTimer();
		this.closeSocketOnly();
		this.setState("unauthorized");
		this.notifyEventStatus(false);
		this.onUnauthorized?.();
	}

	private probeAuthorization(token: string): void {
		if (this.authProbe || !this.online || this.disposed) return;
		this.authProbe = this.fetchFn(`${this.origin}/api/v1/auth/device`, {
			headers: { authorization: `Bearer ${token}` },
			cache: "no-store",
		})
			.then((response) => {
				if (response.status === 401 && this.tokens.getToken() === token) {
					this.markUnauthorized();
				}
			})
			.catch(() => undefined)
			.finally(() => {
				this.authProbe = undefined;
			});
	}

	private requireToken(): string {
		const token = this.tokens.getToken();
		if (!token) {
			this.markUnauthorized();
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
		if (response.status === 401) this.markUnauthorized();
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
					this.markUnauthorized();
				}
				throw HostApiError.fromPayload(payload);
			}
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
		if (response.status === 401) this.markUnauthorized();
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
		onSubscribed?: (ack: TerminalSubscriptionAck) => void,
	): () => void {
		if (this.disposed) return () => undefined;
		let set = this.terminalListeners.get(terminalId);
		const isFirst = !set;
		if (!set) {
			set = new Map();
			this.terminalListeners.set(terminalId, set);
		}
		set.set(listener, onSubscribed);
		this.ensureSocket();
		if (isFirst && this.socketReady && this.socket?.readyState === WS_OPEN) {
			this.sendSocketJson({
				type: "terminal.subscribe",
				terminalId,
				ack: true,
			});
		}
		const ack = this.terminalAcks.get(terminalId);
		if (ack !== undefined) onSubscribed?.(ack);
		return () => {
			const listeners = this.terminalListeners.get(terminalId);
			if (!listeners) return;
			listeners.delete(listener);
			if (listeners.size === 0) {
				this.terminalListeners.delete(terminalId);
				this.terminalAcks.delete(terminalId);
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
			this.helloWaiters.size > 0 ||
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
			this.markUnauthorized();
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
				if (!this.socketReady) return;

				const terminalEvent = parseTerminalEvent(parsed);
				if (terminalEvent) {
					this.broadcastTerminalEvent(terminalEvent);
					return;
				}

				if (parsed.type === "terminal.subscribed") {
					this.handleTerminalAck(parsed);
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
			this.probeAuthorization(token);
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
			this.finishNegotiation(
				new HostApiError(
					"unavailable",
					`Incompatible Host protocol version ${protocolVersion || "(missing)"}; expected major version ${this.expectedMajor}. Upgrade Pilo on the client or Host.`,
					false,
				),
			);
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
			if (stored !== this.socketCursorSent && !this.hostIdSwitchAttempted) {
				this.hostIdSwitchAttempted = true;
				this.closeSocketOnly();
				this.openSocket();
				return;
			}
		}
		this.hostIdSwitchAttempted = false;

		const latestSequence =
			typeof parsed.latestSequence === "number" ? parsed.latestSequence : 0;
		const regressed = latestSequence < this.replayCursor;
		if (regressed) {
			this.setReplayCursor(0, true);
		}

		const reconnect = this.latestHello !== null;
		const hello = parsed as unknown as HostHelloMessage;
		this.latestHello = hello;
		this.latestCapabilities = hello.capabilities ?? null;
		this.socketReady = true;
		this.reconnectAttempts = 0;
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
		} else if (reconnect) {
			this.broadcastEventMessage({
				type: "resyncRequired",
				latestSequence: this.replayCursor,
				replayPending: true,
			});
		}

		// Re-subscribe any active terminal streams on this socket.
		if (this.socket === socket && socket.readyState === WS_OPEN) {
			for (const terminalId of this.terminalListeners.keys()) {
				this.sendSocketJson({
					type: "terminal.subscribe",
					terminalId,
					ack: true,
				});
			}
		}
		this.finishNegotiation();
		this.setState("connected");
		this.notifyEventStatus(true);
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
			for (const listener of Array.from(targeted.keys())) {
				listener(event);
			}
		}
		for (const listener of Array.from(this.allTerminalListeners)) {
			listener(event);
		}
	}

	private handleTerminalAck(parsed: Record<string, unknown>): void {
		if (!this.socketReady || typeof parsed.terminalId !== "string") return;
		const listeners = this.terminalListeners.get(parsed.terminalId);
		if (!listeners) return;
		const error = parseErrorPayload(parsed.error);
		const ack = error
			? new HostApiError(error.code, error.message, error.retryable)
			: parsed.offset;
		if (!(ack instanceof HostApiError) && typeof ack !== "number") return;
		this.terminalAcks.set(parsed.terminalId, ack);
		for (const listener of Array.from(listeners.values())) listener?.(ack);
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
		this.terminalAcks.clear();
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
