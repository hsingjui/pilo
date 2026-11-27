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
	remoteHostConnectOrder,
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
	sameHostAccess,
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
	addressId: string;
	access: Accessor<HostAccess>;
	state: Accessor<HostTransportConnectionState>;
	stop: () => void;
};

type TokenCheck = "ok" | "unauthorized" | "rateLimited" | "unreachable";

type AddressSearch =
	| { kind: "found"; address: RemoteAccessAddress }
	| { kind: "unauthorized" }
	| { kind: "incompatible" }
	| { kind: "unreachable"; rateLimited: boolean }
	/** A newer connect, disconnect or remove superseded the search. */
	| { kind: "stale" };

const CURSOR_KEY = "pilo.eventCursor";
const PROBE_TIMEOUT_MS = 3_000;
const RETRY_PROBE_MS = 10_000;
const MAX_RETRY_MS = 5 * 60_000;
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
	/** The event socket's reconnect delays, for tests. */
	reconnectDelaysMs?: readonly number[];
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
): HostAccess {
	return {
		scopes: hello?.scopes ?? record.scopes,
		methods: hello?.capabilities?.methods ?? null,
	};
}

function retryDelay(attempts: number) {
	return Math.min(
		RETRY_PROBE_MS * 2 ** Math.max(0, attempts - 1),
		MAX_RETRY_MS,
	);
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
	private readonly retryAttempts = new Map<string, number>();
	/** Bumped by every connect, disconnect and remove; older async results are dropped. */
	private readonly generations = new Map<string, number>();
	private readonly rateLimited = signal<ReadonlySet<string>>(new Set());
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
		const rateLimited = this.rateLimited();
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
					if (status !== "connected" && rateLimited.has(record.hostId))
						status = "rateLimited";
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

	private bump(hostId: string): number {
		const generation = (this.generations.get(hostId) ?? 0) + 1;
		this.generations.set(hostId, generation);
		return generation;
	}

	private isCurrent(hostId: string, generation: number): boolean {
		return !this.closed && this.generations.get(hostId) === generation;
	}

	private setRateLimited(hostId: string, limited: boolean) {
		if (this.rateLimited().has(hostId) === limited) return;
		const next = new Set(this.rateLimited());
		if (limited) next.add(hostId);
		else next.delete(hostId);
		this.rateLimited.set(next);
	}

	/** Whether the address takes this device's token: 401 means revoked, 429 only "not now". */
	private async checkToken(
		address: RemoteAccessAddress,
		token: string,
	): Promise<TokenCheck> {
		try {
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
			if (response.ok) return "ok";
			if (response.status === 401) return "unauthorized";
			if (response.status === 429) return "rateLimited";
			return "unreachable";
		} catch {
			return "unreachable";
		}
	}

	/**
	 * The first address, preferred first, where the paired Host itself answers:
	 * the token is taken and the hello names the expected Host.
	 */
	private async findAddress(
		record: RemoteHostRecord,
		token: string,
		generation: number,
	): Promise<AddressSearch> {
		const { hostId } = record;
		let rateLimited = false;
		for (const address of remoteHostConnectOrder(record)) {
			// oxlint-disable-next-line no-await-in-loop -- Addresses are tried in order.
			const check = await this.checkToken(address, token);
			if (!this.isCurrent(hostId, generation)) return { kind: "stale" };
			if (check === "unauthorized") return { kind: "unauthorized" };
			if (check === "rateLimited") rateLimited = true;
			if (check !== "ok") continue;
			let hello: HostHelloMessage | null = null;
			try {
				// oxlint-disable-next-line no-await-in-loop -- Addresses are tried in order.
				hello = await this.greet(address, token);
			} catch (error) {
				if (!this.isCurrent(hostId, generation)) return { kind: "stale" };
				const code = error instanceof Error ? error.message : "";
				if (code === "REMOTE_HOST_UNAUTHORIZED")
					return { kind: "unauthorized" };
				if (code === "REMOTE_HOST_INCOMPATIBLE")
					return { kind: "incompatible" };
				continue;
			}
			if (!this.isCurrent(hostId, generation)) return { kind: "stale" };
			if (hello.hostId === hostId) return { kind: "found", address };
		}
		return { kind: "unreachable", rateLimited };
	}

	private scheduleRetry(hostId: string, backoff: boolean) {
		this.clearRetry(hostId);
		if (this.closed) return;
		const attempts = backoff ? (this.retryAttempts.get(hostId) ?? 0) + 1 : 0;
		if (backoff) this.retryAttempts.set(hostId, attempts);
		else this.retryAttempts.delete(hostId);
		this.retryTimers.set(
			hostId,
			setTimeout(
				() => {
					this.retryTimers.delete(hostId);
					if (!this.disconnected().has(hostId)) void this.connect(hostId);
				},
				backoff ? retryDelay(attempts) : RETRY_PROBE_MS,
			),
		);
	}

	private clearRetry(hostId: string) {
		const timer = this.retryTimers.get(hostId);
		if (timer !== undefined) clearTimeout(timer);
		this.retryTimers.delete(hostId);
	}

	/** Connects to a paired Host: finds an address that answers, then opens its session. */
	async connect(hostId: string): Promise<void> {
		const record = this.record(hostId);
		if (!record || this.connections().has(hostId) || this.closed) return;
		const generation = this.bump(hostId);
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
		if (!this.isCurrent(hostId, generation)) return;
		if (!token) {
			this.setPending(hostId, "unauthorized");
			return;
		}
		const found = await this.findAddress(record, token, generation);
		if (
			found.kind === "stale" ||
			!this.isCurrent(hostId, generation) ||
			!this.record(hostId) ||
			this.connections().has(hostId)
		)
			return;
		if (found.kind === "unauthorized" || found.kind === "incompatible") {
			this.setPending(hostId, found.kind);
			return;
		}
		if (found.kind === "unreachable") {
			this.setPending(hostId, found.rateLimited ? "rateLimited" : "offline");
			this.scheduleRetry(hostId, found.rateLimited);
			return;
		}
		await this.cursors.preload(hostId);
		if (!this.isCurrent(hostId, generation) || this.connections().has(hostId))
			return;
		const current = this.record(hostId);
		if (!current) return;
		this.retryAttempts.delete(hostId);
		this.setRateLimited(hostId, false);
		this.open(current, found.address, token, generation);
	}

	/**
	 * While the event socket is down: a revoked token closes the session, and
	 * another address that answers for the Host takes over from this one.
	 */
	private async recheck(
		hostId: string,
		connection: RemoteConnection,
		generation: number,
	) {
		const live = () =>
			this.isCurrent(hostId, generation) &&
			this.connections().get(hostId) === connection &&
			connection.state() !== "connected";
		const record = this.record(hostId);
		const token = await this.options.credentials
			.remoteHostToken(hostId)
			.catch(() => null);
		if (!record || !token || !live()) return;
		const found = await this.findAddress(record, token, generation);
		if (found.kind === "stale" || !live()) return;
		if (found.kind === "unauthorized") {
			this.close(hostId);
			this.setPending(hostId, "unauthorized");
			return;
		}
		this.setRateLimited(
			hostId,
			found.kind === "unreachable" && found.rateLimited,
		);
		if (found.kind === "found" && found.address.id !== connection.addressId) {
			this.close(hostId);
			void this.connect(hostId);
		}
	}

	private open(
		record: RemoteHostRecord,
		address: RemoteAccessAddress,
		token: string,
		generation: number,
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
			...(this.options.reconnectDelaysMs
				? { reconnectDelaysMs: this.options.reconnectDelaysMs }
				: {}),
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
		const access = computed(
			() => scopedAccess(hello(), this.record(hostId) ?? record),
			{ equals: sameHostAccess },
		);
		let offlineTimer: ReturnType<typeof setTimeout> | undefined;
		let recheckTimer: ReturnType<typeof setTimeout> | undefined;
		let recheckAttempts = 0;
		let stops: Array<(() => void) | undefined> = [];
		const connection: RemoteConnection = {
			session,
			addressId: address.id,
			access,
			state,
			stop: () => {
				heartbeat.stop();
				if (offlineTimer !== undefined) clearTimeout(offlineTimer);
				if (recheckTimer !== undefined) clearTimeout(recheckTimer);
				for (const unsubscribe of stops) unsubscribe?.();
				this.disconnectedSince.delete(hostId);
			},
		};
		const owns = () => this.connections().get(hostId) === connection;
		const scheduleRecheck = (delay: number) => {
			if (recheckTimer !== undefined) return;
			recheckTimer = setTimeout(() => {
				recheckTimer = undefined;
				void this.recheck(hostId, connection, generation).finally(() => {
					if (!owns() || state() === "connected") return;
					recheckAttempts += 1;
					scheduleRecheck(
						this.rateLimited().has(hostId)
							? retryDelay(recheckAttempts)
							: RETRY_PROBE_MS,
					);
				});
			}, delay);
		};
		const stream = transport.events();
		stops = [
			stream.onHello?.((message) => {
				if (!owns()) return;
				if (message.hostId !== hostId) {
					// Another Host answers at this address now: look for this one again.
					queueMicrotask(() => {
						if (!owns()) return;
						this.close(hostId);
						void this.connect(hostId);
					});
					return;
				}
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
				if (!owns()) return;
				state.set(next);
				if (next === "connected") {
					this.disconnectedSince.delete(hostId);
					if (offlineTimer !== undefined) clearTimeout(offlineTimer);
					if (recheckTimer !== undefined) clearTimeout(recheckTimer);
					recheckTimer = undefined;
					recheckAttempts = 0;
					this.setRateLimited(hostId, false);
				} else if (!this.disconnectedSince.has(hostId)) {
					this.disconnectedSince.set(hostId, Date.now());
					offlineTimer = setTimeout(
						() => this.tick.set(this.tick() + 1),
						REMOTE_HOST_OFFLINE_AFTER_MS,
					);
				}
				if (next === "unauthorized") {
					queueMicrotask(() => {
						if (!owns()) return;
						this.close(hostId);
						this.setPending(hostId, "unauthorized");
					});
				} else if (next !== "connected" && next !== "incompatible") {
					// A rejected event socket looks like a network drop; ask over HTTP.
					scheduleRecheck(0);
				}
			}),
		];
		const next = new Map(this.connections());
		next.set(hostId, connection);
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
		this.setRateLimited(hostId, false);
		if (this.active() === hostId) this.active.set(LOCAL_HOST_ID);
	}

	/** Disconnects this window from the Host, keeping its token for later. */
	disconnect(hostId: string) {
		this.bump(hostId);
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
	 * and record. Resolves `false` when the Host could not be told (offline or
	 * rate-limiting this device).
	 */
	async remove(hostId: string): Promise<boolean> {
		const record = this.record(hostId);
		if (!record) return true;
		this.bump(hostId);
		this.clearRetry(hostId);
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
			for (const address of remoteHostConnectOrder(record)) {
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
					// A rejected token was revoked already; 429 says nothing about it.
					revoked = response.ok || response.status === 401;
					if (revoked || response.status === 429) break;
				} catch {
					// Try the next address.
				}
			}
		}
		this.bump(hostId);
		this.clearRetry(hostId);
		this.retryAttempts.delete(hostId);
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
		/** Plain-http addresses outside private networks the user agreed to. */
		plaintextAddressIds?: string[];
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
			plaintextAddressIds: input.plaintextAddressIds ?? [],
		};
		this.bump(record.hostId);
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
