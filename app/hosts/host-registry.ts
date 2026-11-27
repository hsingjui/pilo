import { type Accessor, computed, signal } from "nsh";

import { HostClient } from "@shared/api/host-client";
import {
	type CursorStore,
	type HostHelloMessage,
	HttpTransport,
	type HostTransportConnectionState,
	type NetworkSignals,
	type WebSocketLike,
} from "@shared/api/host-transport";
import type {
	RemoteAccessAddress,
	RemoteScopes,
} from "@shared/api/remote-types";
import { hostStorageKey, LOCAL_HOST_ID } from "@shared/host-id";
import {
	parseRemoteHostRecords,
	REMOTE_HOST_OFFLINE_AFTER_MS,
	REMOTE_HOSTS_STORAGE_KEY,
	remoteHostAddressOrder,
	resolveRemoteHostStatus,
	serializeRemoteHostRecords,
	upsertRemoteHostRecord,
	type RemoteHostRecord,
	type RemoteHostStatus,
} from "@shared/remote-hosts";
import type { DesktopShell } from "../shell/desktop-shell";
import {
	type HostAccess,
	HostSession,
	LOCAL_HOST_ACCESS,
} from "./host-session";
import { SessionScopedTransport } from "./session-scoped-transport";

/** The native calls for remote Host credentials. */
export type RemoteHostCredentials = {
	remoteHostToken(hostId: string): Promise<string | null>;
	saveRemoteHostToken(hostId: string, token: string): Promise<void>;
	deleteRemoteHostToken(hostId: string): Promise<void>;
};

type AsyncStorage = {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	removeItem(key: string): Promise<void>;
};

export type HostEntryStatus = RemoteHostStatus | "disconnected";

export type HostEntry = {
	hostId: string;
	name: string;
	kind: "local" | "remote";
	status: HostEntryStatus;
	session: HostSession | null;
};

type RemoteConnection = {
	session: HostSession;
	access: Accessor<HostAccess>;
	state: Accessor<HostTransportConnectionState>;
	stop: () => void;
};

const CURSOR_KEY = "pilo.eventCursor";
const PROBE_TIMEOUT_MS = 3_000;
const RETRY_PROBE_MS = 10_000;
const HELLO_TIMEOUT_MS = 10_000;
/** How often an idle event socket is pinged so a silently dropped link is noticed. */
const HEARTBEAT_MS = 15_000;

export type HostRegistryOptions = {
	local: HostSession;
	shell: DesktopShell;
	credentials: RemoteHostCredentials;
	storage: AsyncStorage;
	fetch?: typeof fetch;
	createWebSocket?: (url: string, protocols?: string[]) => WebSocketLike;
};

function defaultWebSocket(url: string, protocols?: string[]): WebSocketLike {
	return new WebSocket(url, protocols) as unknown as WebSocketLike;
}

/** The persisted event cursor of each Host, read before its transport starts. */
class StorageCursorStore implements CursorStore {
	private readonly cursors = new Map<string, number>();
	constructor(private readonly storage: AsyncStorage) {}

	async preload(hostId: string) {
		const raw = await this.storage
			.getItem(hostStorageKey(hostId, CURSOR_KEY))
			.catch(() => null);
		const value = Number(raw);
		this.cursors.set(
			hostId,
			Number.isSafeInteger(value) && value > 0 ? value : 0,
		);
	}

	getCursor(hostId: string): number {
		return this.cursors.get(hostId) ?? 0;
	}

	setCursor(hostId: string, sequence: number): void {
		const value = Math.max(0, Math.floor(sequence));
		this.cursors.set(hostId, value);
		void this.storage
			.setItem(hostStorageKey(hostId, CURSOR_KEY), String(value))
			.catch(() => undefined);
	}

	forget(hostId: string) {
		this.cursors.delete(hostId);
		void this.storage
			.removeItem(hostStorageKey(hostId, CURSOR_KEY))
			.catch(() => undefined);
	}
}

function scopedAccess(
	hello: HostHelloMessage | null,
	record: RemoteHostRecord,
) {
	return {
		scopes: hello?.scopes ?? record.scopes,
		methods: hello?.capabilities?.methods ?? null,
	};
}

/**
 * The Hosts this window shows: the embedded Host and the paired remote
 * ones. Remote records live in app storage and their device tokens in the
 * system credential store; each connected Host has a HostSession of its own.
 */
export class HostRegistry {
	readonly local: HostSession;
	private readonly records = signal<RemoteHostRecord[]>([]);
	private readonly disconnected = signal<ReadonlySet<string>>(new Set());
	private readonly connections = signal<ReadonlyMap<string, RemoteConnection>>(
		new Map(),
	);
	private readonly pendingStatus = signal<ReadonlyMap<string, HostEntryStatus>>(
		new Map(),
	);
	private readonly tick = signal(0);
	private readonly active = signal(LOCAL_HOST_ID);
	private readonly retryTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	private readonly cursors: StorageCursorStore;
	private readonly fetchFn: typeof fetch;
	private readonly createWebSocket: (
		url: string,
		protocols?: string[],
	) => WebSocketLike;
	private closed = false;

	readonly activeHostId: Accessor<string> = () => this.active();

	constructor(private readonly options: HostRegistryOptions) {
		this.local = options.local;
		this.cursors = new StorageCursorStore(options.storage);
		this.fetchFn = options.fetch ?? fetch;
		this.createWebSocket = options.createWebSocket ?? defaultWebSocket;
	}

	/** Every Host, the embedded one first, with its sidebar status. */
	readonly entries: Accessor<HostEntry[]> = () => {
		this.tick();
		const connections = this.connections();
		const pending = this.pendingStatus();
		const disconnected = this.disconnected();
		return [
			{
				hostId: LOCAL_HOST_ID,
				name: "",
				kind: "local" as const,
				status: "connected" as const,
				session: this.local,
			},
			...this.records().map((record): HostEntry => {
				const connection = connections.get(record.hostId);
				let status: HostEntryStatus;
				if (connection) {
					status = resolveRemoteHostStatus(
						connection.state(),
						this.disconnectedFor(record.hostId),
					);
				} else if (disconnected.has(record.hostId)) {
					status = "disconnected";
				} else {
					status = pending.get(record.hostId) ?? "connecting";
				}
				return {
					hostId: record.hostId,
					name: record.name,
					kind: "remote",
					status,
					session: connection?.session ?? null,
				};
			}),
		];
	};

	/** The session the window shows. */
	readonly activeSession: Accessor<HostSession> = () =>
		this.connections().get(this.active())?.session ?? this.local;

	/** Every open session, for the effects that follow them. */
	readonly sessions: Accessor<HostSession[]> = () => [
		this.local,
		...[...this.connections().values()].map(({ session }) => session),
	];

	/** The Dock badge: unread finished turns on every connected Host. */
	readonly unreadCount: Accessor<number> = () =>
		this.sessions().reduce((sum, session) => sum + session.unreadCount(), 0);

	record(hostId: string): RemoteHostRecord | null {
		return this.records().find((record) => record.hostId === hostId) ?? null;
	}

	access(hostId: string): HostAccess {
		return this.connections().get(hostId)?.access() ?? LOCAL_HOST_ACCESS;
	}

	private readonly disconnectedSince = new Map<string, number>();

	private disconnectedFor(hostId: string) {
		const since = this.disconnectedSince.get(hostId);
		return since === undefined ? 0 : Date.now() - since;
	}

	async load(): Promise<void> {
		const raw = await this.options.storage
			.getItem(REMOTE_HOSTS_STORAGE_KEY)
			.catch(() => null);
		const records = parseRemoteHostRecords(raw);
		const disconnected = new Set(
			parseDisconnected(
				await this.options.storage
					.getItem(`${REMOTE_HOSTS_STORAGE_KEY}.disconnected`)
					.catch(() => null),
			),
		);
		this.records.set(records);
		this.disconnected.set(disconnected);
		for (const record of records) {
			if (!disconnected.has(record.hostId)) void this.connect(record.hostId);
		}
	}

	private async saveRecords() {
		await this.options.storage.setItem(
			REMOTE_HOSTS_STORAGE_KEY,
			serializeRemoteHostRecords(this.records()),
		);
		await this.options.storage.setItem(
			`${REMOTE_HOSTS_STORAGE_KEY}.disconnected`,
			JSON.stringify([...this.disconnected()]),
		);
	}

	private setPending(hostId: string, status: HostEntryStatus | null) {
		const next = new Map(this.pendingStatus());
		if (status) next.set(hostId, status);
		else next.delete(hostId);
		this.pendingStatus.set(next);
	}

	/** The first address that answers with this device's token, preferred first. */
	private async probe(
		record: RemoteHostRecord,
		token: string,
	): Promise<RemoteAccessAddress | "unauthorized" | null> {
		for (const address of remoteHostAddressOrder(record)) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- Addresses are tried in order.
				const response = await this.fetchFn(
					`${address.baseUrl}/api/v2/call/preferences.get`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${token}`,
							"content-type": "application/json",
						},
						body: "{}",
						signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
					},
				);
				if (response.ok) return address;
				// The Host only rate-limits rejected tokens, so 429 means the same.
				if (response.status === 401 || response.status === 429) {
					return "unauthorized";
				}
			} catch {
				// Unreachable: try the next address.
			}
		}
		return null;
	}

	private async checkRevoked(hostId: string) {
		const record = this.record(hostId);
		const token = await this.options.credentials
			.remoteHostToken(hostId)
			.catch(() => null);
		if (!record || !token || !this.connections().has(hostId)) return;
		if ((await this.probe(record, token)) !== "unauthorized") return;
		if (!this.connections().has(hostId)) return;
		this.close(hostId);
		this.setPending(hostId, "unauthorized");
	}

	private scheduleRetry(hostId: string) {
		this.clearRetry(hostId);
		if (this.closed) return;
		this.retryTimers.set(
			hostId,
			setTimeout(() => {
				this.retryTimers.delete(hostId);
				if (!this.disconnected().has(hostId)) void this.connect(hostId);
			}, RETRY_PROBE_MS),
		);
	}

	private clearRetry(hostId: string) {
		const timer = this.retryTimers.get(hostId);
		if (timer !== undefined) clearTimeout(timer);
		this.retryTimers.delete(hostId);
	}

	/** Connects to a paired Host: tries its addresses, then opens its session. */
	async connect(hostId: string): Promise<void> {
		const record = this.record(hostId);
		if (!record || this.connections().has(hostId) || this.closed) return;
		this.clearRetry(hostId);
		if (this.disconnected().has(hostId)) {
			const next = new Set(this.disconnected());
			next.delete(hostId);
			this.disconnected.set(next);
			void this.saveRecords().catch(() => undefined);
		}
		this.setPending(hostId, "connecting");
		const token = await this.options.credentials
			.remoteHostToken(hostId)
			.catch(() => null);
		if (!token) {
			this.setPending(hostId, "unauthorized");
			return;
		}
		const address = await this.probe(record, token);
		if (this.connections().has(hostId) || this.disconnected().has(hostId))
			return;
		if (!this.record(hostId)) return;
		if (address === "unauthorized") {
			this.setPending(hostId, "unauthorized");
			return;
		}
		if (!address) {
			this.setPending(hostId, "offline");
			this.scheduleRetry(hostId);
			return;
		}
		await this.cursors.preload(hostId);
		this.open(record, address, token);
	}

	private open(
		record: RemoteHostRecord,
		address: RemoteAccessAddress,
		token: string,
	) {
		const { hostId } = record;
		const heartbeat = heartbeatSignals(HEARTBEAT_MS);
		const http = new HttpTransport({
			origin: address.baseUrl,
			hostId,
			network: heartbeat.signals,
			foregroundProbeMinHiddenMs: 0,
			tokens: { getToken: () => token },
			cursors: this.cursors,
			fetch: this.fetchFn as never,
			createWebSocket: this.createWebSocket,
		});
		const transport = new SessionScopedTransport(http);
		const session = new HostSession({
			hostId,
			kind: "remote",
			client: new HostClient(transport),
			shell: this.options.shell,
		});
		const hello = signal<HostHelloMessage | null>(null);
		const state = signal<HostTransportConnectionState>("connecting");
		const access = computed(() =>
			scopedAccess(hello(), this.record(hostId) ?? record),
		);
		const stream = transport.events();
		let offlineTimer: ReturnType<typeof setTimeout> | undefined;
		const stops = [
			stream.onHello?.((message) => {
				hello.set(message);
				const current = this.record(hostId);
				if (!current) return;
				const next = {
					...current,
					name: message.hostName || current.name,
					scopes: message.scopes,
					platform: message.capabilities?.platform ?? current.platform,
					preferredAddressId: current.preferredAddressId,
				};
				if (JSON.stringify(next) !== JSON.stringify(current)) {
					this.records.set(upsertRemoteHostRecord(this.records(), next));
					void this.saveRecords().catch(() => undefined);
				}
			}),
			stream.onConnectionState?.((next) => {
				state.set(next);
				if (next === "connected") {
					this.disconnectedSince.delete(hostId);
					if (offlineTimer !== undefined) clearTimeout(offlineTimer);
				} else if (!this.disconnectedSince.has(hostId)) {
					this.disconnectedSince.set(hostId, Date.now());
					offlineTimer = setTimeout(
						() => this.tick.set(this.tick() + 1),
						REMOTE_HOST_OFFLINE_AFTER_MS,
					);
					// A rejected event socket looks like a network drop; ask over HTTP.
					if (next !== "unauthorized") void this.checkRevoked(hostId);
				}
				if (next === "unauthorized") {
					queueMicrotask(() => {
						this.close(hostId);
						this.setPending(hostId, "unauthorized");
					});
				}
			}),
		];
		const stop = () => {
			heartbeat.stop();
			if (offlineTimer !== undefined) clearTimeout(offlineTimer);
			for (const unsubscribe of stops) unsubscribe?.();
			this.disconnectedSince.delete(hostId);
		};
		const next = new Map(this.connections());
		next.set(hostId, { session, access, state, stop });
		this.connections.set(next);
		this.setPending(hostId, null);
		void session.start().catch((error: unknown) => {
			console.warn(`Failed to start the session of Host ${hostId}`, error);
		});
	}

	/** Disposes the Host's session in this window; the remote Host is not told to stop. */
	private close(hostId: string) {
		const connection = this.connections().get(hostId);
		if (!connection) return;
		const next = new Map(this.connections());
		next.delete(hostId);
		this.connections.set(next);
		connection.stop();
		connection.session.dispose();
		if (this.active() === hostId) this.active.set(LOCAL_HOST_ID);
	}

	/** Disconnects this window from the Host, keeping its token for later. */
	disconnect(hostId: string) {
		this.clearRetry(hostId);
		this.close(hostId);
		this.setPending(hostId, null);
		const next = new Set(this.disconnected());
		next.add(hostId);
		this.disconnected.set(next);
		void this.saveRecords().catch(() => undefined);
	}

	/**
	 * Unpairs the Host: asks it to revoke this device, then forgets its token
	 * and record. Resolves `false` when the Host could not be told (offline).
	 */
	async remove(hostId: string): Promise<boolean> {
		const record = this.record(hostId);
		if (!record) return true;
		let revoked = false;
		const connection = this.connections().get(hostId);
		if (connection) {
			revoked = await connection.session.client
				.revokeSelf()
				.then(() => true)
				.catch(() => false);
		}
		const token = await this.options.credentials
			.remoteHostToken(hostId)
			.catch(() => null);
		if (!revoked && token) {
			for (const address of remoteHostAddressOrder(record)) {
				try {
					// oxlint-disable-next-line no-await-in-loop -- Addresses are tried in order.
					const response = await this.fetchFn(
						`${address.baseUrl}/api/v2/call/device.revokeSelf`,
						{
							method: "POST",
							headers: {
								authorization: `Bearer ${token}`,
								"content-type": "application/json",
							},
							body: "{}",
							signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
						},
					);
					// A device revoked already counts: the Host no longer lists it.
					revoked =
						response.ok || response.status === 401 || response.status === 429;
					if (revoked) break;
				} catch {
					// Try the next address.
				}
			}
		}
		this.clearRetry(hostId);
		this.close(hostId);
		this.setPending(hostId, null);
		await this.options.credentials.deleteRemoteHostToken(hostId);
		this.cursors.forget(hostId);
		this.records.set(this.records().filter((item) => item.hostId !== hostId));
		const disconnected = new Set(this.disconnected());
		disconnected.delete(hostId);
		this.disconnected.set(disconnected);
		await this.saveRecords();
		return revoked;
	}

	/** Learns the Host's id and name from its hello, with a just-paired token. */
	private async greet(
		address: RemoteAccessAddress,
		token: string,
	): Promise<HostHelloMessage> {
		const transport = new HttpTransport({
			origin: address.baseUrl,
			tokens: { getToken: () => token },
			fetch: this.fetchFn as never,
			createWebSocket: this.createWebSocket,
		});
		try {
			return await new Promise<HostHelloMessage>((resolve, reject) => {
				const stream = transport.events();
				const timer = setTimeout(
					() => reject(new Error("REMOTE_HOST_HELLO_TIMEOUT")),
					HELLO_TIMEOUT_MS,
				);
				stream.onHello?.((hello) => {
					clearTimeout(timer);
					resolve(hello);
				});
				stream.onConnectionState?.((state) => {
					if (state === "unauthorized" || state === "incompatible") {
						clearTimeout(timer);
						reject(new Error(`REMOTE_HOST_${state.toUpperCase()}`));
					}
				});
				stream.subscribeEvents({
					onMessage: () => undefined,
					onStatus: () => undefined,
				});
			});
		} finally {
			transport.dispose();
		}
	}

	/** Saves a Host this desktop just paired with and connects to it. */
	async addPaired(input: {
		addresses: RemoteAccessAddress[];
		preferredAddressId: string;
		token: string;
		deviceId: string;
		scopes: RemoteScopes;
	}): Promise<RemoteHostRecord> {
		const preferred =
			input.addresses.find(({ id }) => id === input.preferredAddressId) ??
			input.addresses[0];
		const hello = await this.greet(preferred, input.token);
		const record: RemoteHostRecord = {
			hostId: hello.hostId,
			name: hello.hostName,
			addresses: input.addresses.map(({ id, name, baseUrl }) => ({
				id,
				name,
				baseUrl,
			})),
			preferredAddressId: preferred.id,
			deviceId: hello.deviceId ?? input.deviceId,
			scopes: hello.scopes ?? input.scopes,
			platform: hello.capabilities?.platform,
		};
		this.close(record.hostId);
		await this.options.credentials.saveRemoteHostToken(
			record.hostId,
			input.token,
		);
		this.records.set(upsertRemoteHostRecord(this.records(), record));
		const disconnected = new Set(this.disconnected());
		disconnected.delete(record.hostId);
		this.disconnected.set(disconnected);
		await this.saveRecords();
		await this.connect(record.hostId);
		return record;
	}

	/** Shows the Host's session; a remote Host not connected is connected first. */
	activate(hostId: string) {
		if (hostId === LOCAL_HOST_ID || this.connections().has(hostId)) {
			this.active.set(hostId);
			return;
		}
		void this.connect(hostId);
	}

	/** On quit: closes every remote session and shuts down only the embedded Host. */
	async shutdown(): Promise<void> {
		this.closed = true;
		for (const hostId of [...this.retryTimers.keys()]) this.clearRetry(hostId);
		for (const hostId of [...this.connections().keys()]) this.close(hostId);
		await this.local.shutdown();
	}
}

function parseDisconnected(raw: string | null): string[] {
	try {
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed)
			? parsed.filter((id): id is string => typeof id === "string")
			: [];
	} catch {
		return [];
	}
}

/**
 * Desktop windows have no visibility changes to probe on, so the event socket
 * is pinged on a timer and reconnected when the ping goes unanswered.
 */
function heartbeatSignals(intervalMs: number): {
	signals: NetworkSignals;
	stop(): void;
} {
	const background = new Set<() => void>();
	const foreground = new Set<() => void>();
	const subscribe = (set: Set<() => void>) => (listener: () => void) => {
		set.add(listener);
		return () => {
			set.delete(listener);
		};
	};
	const timer = setInterval(() => {
		for (const listener of [...background]) listener();
		for (const listener of [...foreground]) listener();
	}, intervalMs);
	return {
		signals: {
			onBackground: subscribe(background),
			onForeground: subscribe(foreground),
		},
		stop: () => clearInterval(timer),
	};
}
