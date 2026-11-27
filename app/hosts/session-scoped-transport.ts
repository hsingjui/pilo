import { HostApiError, type TerminalEvent } from "@shared/api/host-methods";
import type {
	HostCallOptions,
	HostEventStream,
	HostHelloMessage,
	HostTransport,
	HostTransportConnectionState,
	TerminalSubscriptionAck,
} from "@shared/api/host-transport";
import type { PiloClientEventOptions } from "@shared/api/pilo-client";

function staleSession() {
	return new HostApiError("unavailable", "Host session was closed", false);
}

/**
 * A HostSession's view of its transport: once the session is disposed (the
 * Host was disconnected or replaced), late responses reject and late events
 * are dropped, so they never reach a store of another session.
 */
export class SessionScopedTransport implements HostTransport {
	private disposed = false;
	private readonly unsubscribers = new Set<() => void>();
	private stream: HostEventStream | null = null;

	constructor(private readonly inner: HostTransport) {}

	get closed(): boolean {
		return this.disposed || Boolean(this.inner.closed);
	}

	get capabilities() {
		return this.inner.capabilities ?? null;
	}

	get reconnectsEvents() {
		return this.inner.reconnectsEvents;
	}

	private guard<T>(promise: Promise<T>): Promise<T> {
		return promise.then(
			(value) => {
				if (this.disposed) throw staleSession();
				return value;
			},
			(error: unknown) => {
				throw this.disposed ? staleSession() : error;
			},
		);
	}

	call<T>(method: string, params: unknown, opts?: HostCallOptions): Promise<T> {
		if (this.disposed) return Promise.reject(staleSession());
		return this.guard(this.inner.call<T>(method, params, opts));
	}

	upload<T = unknown>(
		method: string,
		params: Record<string, string>,
		bytes: Uint8Array,
		opts?: HostCallOptions,
	): Promise<T> {
		if (this.disposed) return Promise.reject(staleSession());
		return this.guard(this.inner.upload<T>(method, params, bytes, opts));
	}

	download(
		method: string,
		params: Record<string, string>,
		opts?: HostCallOptions,
	): Promise<Uint8Array<ArrayBuffer>> {
		if (this.disposed) return Promise.reject(staleSession());
		return this.guard(this.inner.download(method, params, opts));
	}

	private track(unsubscribe: () => void): () => void {
		if (this.disposed) {
			unsubscribe();
			return () => undefined;
		}
		const stop = () => {
			if (!this.unsubscribers.delete(stop)) return;
			unsubscribe();
		};
		this.unsubscribers.add(stop);
		return stop;
	}

	private live<A extends unknown[]>(listener: (...args: A) => void) {
		return (...args: A) => {
			if (!this.disposed) listener(...args);
		};
	}

	events(): HostEventStream {
		if (this.stream) return this.stream;
		const inner = this.inner.events();
		const stream: HostEventStream = {
			subscribeEvents: (options: PiloClientEventOptions) =>
				this.track(
					inner.subscribeEvents({
						...options,
						onMessage: this.live(options.onMessage),
						onStatus: this.live(options.onStatus),
					}),
				),
			subscribeTerminal: (
				terminalId: string,
				listener: (event: TerminalEvent) => void,
				onSubscribed?: (ack: TerminalSubscriptionAck) => void,
			) =>
				this.track(
					inner.subscribeTerminal(
						terminalId,
						this.live(listener),
						onSubscribed && this.live(onSubscribed),
					),
				),
		};
		if (inner.subscribeAllTerminals) {
			const subscribeAll = inner.subscribeAllTerminals.bind(inner);
			stream.subscribeAllTerminals = (listener) =>
				this.track(subscribeAll(this.live(listener)));
		}
		if (inner.nextTerminalEvents) {
			const next = inner.nextTerminalEvents.bind(inner);
			stream.nextTerminalEvents = (max) =>
				this.disposed ? Promise.resolve([]) : this.guard(next(max));
		}
		if (inner.onHello) {
			const onHello = inner.onHello.bind(inner);
			stream.onHello = (listener: (hello: HostHelloMessage) => void) =>
				this.track(onHello(this.live(listener)));
		}
		if (inner.onConnectionState) {
			const onState = inner.onConnectionState.bind(inner);
			stream.onConnectionState = (
				listener: (state: HostTransportConnectionState) => void,
			) => this.track(onState(this.live(listener)));
		}
		if (inner.reconnectNow) {
			const reconnect = inner.reconnectNow.bind(inner);
			stream.reconnectNow = () => {
				if (!this.disposed) reconnect();
			};
		}
		this.stream = stream;
		return stream;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const stop of [...this.unsubscribers]) stop();
		this.unsubscribers.clear();
		this.inner.dispose();
	}
}
