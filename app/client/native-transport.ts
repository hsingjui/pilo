import type { Pilo } from "app/native";

import { HostClient } from "@shared/api/host-client";
import type { TerminalEvent } from "@shared/api/host-methods";
import type {
	HostEventStream,
	HostTransport,
} from "@shared/api/host-transport";
import type {
	PiloClientEvent,
	PiloClientEventMessage,
	PiloClientEventOptions,
} from "@shared/api/pilo-client";

const EVENT_BATCH_SIZE = 256;
const TERMINAL_EVENT_BATCH_SIZE = 256;

type NativeEventBatch =
	| { type: "events"; events: PiloClientEvent[] }
	| { type: "gap"; firstMissed: number; lastMissed: number }
	| { type: "closed" };

/** The native methods `NativeTransport` requires; tests can pass a stand-in. */
export type NativeHostBackend = Pick<
	Pilo,
	"call" | "upload" | "download" | "nextEvents" | "shutdown"
> &
	Partial<Pick<Pilo, "nextTerminalEvents">>;

/**
 * In-process `HostTransport` backed by the embedded desktop `Pilo` native
 * module (`app/native`).
 */
export class NativeTransport implements HostTransport {
	private readonly listeners = new Set<PiloClientEventOptions>();
	private readonly terminalListeners = new Map<
		string,
		Set<(event: TerminalEvent) => void>
	>();
	private readonly allTerminalListeners = new Set<
		(event: TerminalEvent) => void
	>();
	private held: NativeEventBatch | undefined;
	private polling = false;
	private pollingTerminals = false;
	private streamClosed = false;
	private readonly stream: HostEventStream;

	constructor(private readonly pilo: NativeHostBackend) {
		this.stream = {
			subscribeEvents: (options) => this.subscribeEvents(options),
			subscribeTerminal: (terminalId, listener) =>
				this.subscribeTerminal(terminalId, listener),
			subscribeAllTerminals: (listener) => this.subscribeAllTerminals(listener),
			nextTerminalEvents: (max) => this.nextTerminalEvents(max),
		};
	}

	get closed(): boolean {
		return this.streamClosed;
	}

	events(): HostEventStream {
		return this.stream;
	}

	async call<T>(method: string, params: unknown): Promise<T> {
		if (method === "host.shutdown") {
			await this.pilo.shutdown();
			return undefined as T;
		}
		return (await this.pilo.call(method, (params ?? {}) as never)) as T;
	}

	async upload<T = unknown>(
		method: string,
		params: Record<string, string>,
		bytes: Uint8Array,
	): Promise<T> {
		return (await this.pilo.upload(method, params as never, bytes)) as T;
	}

	async download(
		method: string,
		params: Record<string, string>,
	): Promise<Uint8Array<ArrayBuffer>> {
		const normalized: Record<string, unknown> = { ...params };
		if (typeof normalized.expectedFileSize === "string") {
			const parsed = Number(normalized.expectedFileSize);
			if (Number.isSafeInteger(parsed) && parsed >= 0) {
				normalized.expectedFileSize = parsed;
			}
		}
		const bytes = await this.pilo.download(method, normalized as never);
		return new Uint8Array(bytes);
	}

	dispose(): void {
		this.streamClosed = true;
		this.disconnect();
		this.terminalListeners.clear();
		this.allTerminalListeners.clear();
	}

	private subscribeEvents(options: PiloClientEventOptions): () => void {
		if (this.streamClosed) {
			options.onStatus(false);
			return () => undefined;
		}
		this.listeners.add(options);
		options.onStatus(true);
		void this.poll();
		return () => {
			if (this.listeners.delete(options)) options.onStatus(false);
		};
	}

	private subscribeTerminal(
		terminalId: string,
		listener: (event: TerminalEvent) => void,
	): () => void {
		let set = this.terminalListeners.get(terminalId);
		if (!set) {
			set = new Set();
			this.terminalListeners.set(terminalId, set);
		}
		set.add(listener);
		void this.pollTerminals();
		return () => {
			const listeners = this.terminalListeners.get(terminalId);
			if (!listeners) return;
			listeners.delete(listener);
			if (listeners.size === 0) {
				this.terminalListeners.delete(terminalId);
			}
		};
	}

	private subscribeAllTerminals(
		listener: (event: TerminalEvent) => void,
	): () => void {
		this.allTerminalListeners.add(listener);
		void this.pollTerminals();
		return () => {
			this.allTerminalListeners.delete(listener);
		};
	}

	private async nextTerminalEvents(max: number): Promise<TerminalEvent[]> {
		if (!this.pilo.nextTerminalEvents) {
			throw new Error("The native call nextTerminalEvents is unavailable");
		}
		return (await this.pilo.nextTerminalEvents(max)) as TerminalEvent[];
	}

	private async poll(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			while (this.listeners.size > 0) {
				const batch =
					this.held ??
					((await this.pilo.nextEvents(EVENT_BATCH_SIZE)) as NativeEventBatch);
				this.held = undefined;
				if (batch.type === "closed") {
					this.streamClosed = true;
					break;
				}
				if (this.listeners.size === 0) {
					this.held = batch;
					break;
				}
				this.publish(
					batch.type === "gap"
						? { type: "resyncRequired", latestSequence: batch.lastMissed }
						: batch,
				);
			}
		} catch (error) {
			console.error("Pilo event polling failed", error);
		}
		this.polling = false;
		this.disconnect();
	}

	private async pollTerminals(): Promise<void> {
		if (this.pollingTerminals || !this.pilo.nextTerminalEvents) return;
		this.pollingTerminals = true;
		try {
			while (
				this.terminalListeners.size > 0 ||
				this.allTerminalListeners.size > 0
			) {
				const batch = await this.nextTerminalEvents(TERMINAL_EVENT_BATCH_SIZE);
				if (batch.length === 0) break;
				for (const event of batch) {
					const targeted = this.terminalListeners.get(event.terminalId);
					if (targeted) {
						for (const listener of Array.from(targeted)) {
							notify(() => listener(event));
						}
					}
					for (const listener of Array.from(this.allTerminalListeners)) {
						notify(() => listener(event));
					}
				}
			}
		} catch (error) {
			console.error("Pilo terminal event polling failed", error);
		}
		this.pollingTerminals = false;
	}

	private publish(message: PiloClientEventMessage): void {
		for (const listener of Array.from(this.listeners)) {
			notify(() => listener.onMessage(message));
		}
	}

	private disconnect(): void {
		const listeners = Array.from(this.listeners);
		this.listeners.clear();
		for (const listener of listeners) {
			notify(() => listener.onStatus(false));
		}
	}
}

export function createNativeHostClient(pilo: NativeHostBackend): HostClient {
	return new HostClient(new NativeTransport(pilo));
}

function notify(call: () => void): void {
	try {
		call();
	} catch (error) {
		console.error("Pilo event listener failed", error);
	}
}
