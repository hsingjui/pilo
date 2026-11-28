import { type Accessor, batch, computed, signal } from "nsh";

import { HostClient } from "@shared/api/host-client";
import {
	type CursorStore,
	type FetchLike,
	type HostHelloMessage,
	HttpTransport,
	type HostTransportConnectionState,
	type NetworkSignals,
	type WebSocketFactory,
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
	type RemoteHostProxy,
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

type RemoteHostNetwork = {
	fetch: FetchLike;
	createWebSocket: WebSocketFactory;
};

export type RemoteHostProxyTransport = {
	connect(proxy: RemoteHostProxy): RemoteHostNetwork;
	savedUrl(hostId: string): Promise<string | null>;
	saveUrl(hostId: string, url: string): Promise<void>;
	deleteUrl(hostId: string): Promise<void>;
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
	shownInHome: boolean;
	session: HostSession | null;
};

type RemoteConnection = {
	session: HostSession;
	addressId: string;
	network: RemoteHostNetwork;
	access: Accessor<HostAccess>;
	state: Accessor<HostTransportConnectionState>;
	startup: Promise<void>;
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
	proxy?: RemoteHostProxyTransport;
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
	private readonly revealed = signal<string | null>(null);
	private readonly activation = signal<{
		hostId: string;
		revealProjects: boolean;
	} | null>(null);
	private readonly connecting = new Map<string, Promise<void>>();
	private readonly retryTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	private readonly retryAttempts = new Map<string, number>();
	/** Bumped by every connect, disconnect and remove; older async results are dropped. */
	private readonly generations = new Map<string, number>();
	private readonly rateLimited = signal<ReadonlySet<string>>(new Set());
	private readonly cursors: StorageCursorStore;
	private readonly directNetwork: RemoteHostNetwork;
	private readonly proxyEdits = new Set<string>();
	private closed = false;

	readonly activeHostId: Accessor<string> = () => this.active();
	readonly openingHostId: Accessor<string | null> = () =>
		this.activation()?.hostId ?? null;
	/** A sidebar click opens the group without overwriting its saved fold state. */
	readonly revealedHostId: Accessor<string | null> = () => this.revealed();

	clearSidebarReveal(hostId: string) {
		if (this.revealed() === hostId) this.revealed.set(null);
	}

	constructor(private readonly options: HostRegistryOptions) {
		this.local = options.local;
		this.cursors = new StorageCursorStore(options.storage);
		this.directNetwork = {
			fetch: (options.fetch ?? fetch) as unknown as FetchLike,
			createWebSocket: options.createWebSocket ?? defaultWebSocket,
		};
	}

	network(proxy?: RemoteHostProxy): RemoteHostNetwork {
		if (!proxy) return this.directNetwork;
		if (!this.options.proxy) throw new Error("REMOTE_PROXY_SYSTEM_FAILED");
		return this.options.proxy.connect(proxy);
	}

	private async savedNetwork(
		record: RemoteHostRecord,
	): Promise<RemoteHostNetwork> {
		if (record.proxyMode === "system") return this.network({ mode: "system" });
		if (record.proxyMode !== "custom") return this.network();
		if (this.proxyEdits.has(record.hostId))
			throw new Error("REMOTE_PROXY_CREDENTIALS_FAILED");
		const url = await this.options.proxy?.savedUrl(record.hostId);
		if (!url || this.proxyEdits.has(record.hostId))
			throw new Error("REMOTE_PROXY_CREDENTIALS_FAILED");
		return this.network({ mode: "custom", url });
	}

	/** Every Host, the embedded one first, with its connection status. */
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
				shownInHome: true,
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
					name: record.nameOverride ?? record.name,
					kind: "remote",
					status,
					shownInHome: record.shownInHome ?? true,
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

	displayName(hostId: string): string | undefined {
		const record = this.record(hostId);
		return record?.nameOverride ?? record?.name;
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

	private saveHostRecords() {
		return this.options.storage.setItem(
			REMOTE_HOSTS_STORAGE_KEY,
			serializeRemoteHostRecords(this.records()),
		);
	}

	private async saveRecords() {
		await this.saveHostRecords();
		await this.options.storage.setItem(
			`${REMOTE_HOSTS_STORAGE_KEY}.disconnected`,
			JSON.stringify([...this.disconnected()]),
		);
	}

	setShownInHome(hostId: string, shown: boolean): Promise<void> {
		return this.updatePreference(hostId, "shownInHome", shown);
	}

	/** undefined keeps the saved proxy; null switches to a direct connection. */
	async updateConnection(
		hostId: string,
		name: string,
		proxy: RemoteHostProxy | null | undefined,
	): Promise<void> {
		const record = this.record(hostId);
		const trimmed = name.trim();
		if (!record || !trimmed) return;
		const nameOverride = trimmed === record.name ? undefined : trimmed;
		if (proxy === undefined) {
			await this.updatePreference(hostId, "nameOverride", nameOverride);
			return;
		}
		const credentials = this.options.proxy;
		if (!credentials || this.proxyEdits.has(hostId))
			throw new Error("REMOTE_PROXY_CREDENTIALS_FAILED");

		// Do not combine new credentials with an old record's plaintext approvals.
		this.proxyEdits.add(hostId);
		try {
			const previousUrl =
				record.proxyMode === "custom"
					? await credentials.savedUrl(hostId)
					: null;
			if (proxy?.mode === "custom")
				await credentials.saveUrl(hostId, proxy.url);
			else if (previousUrl !== null) await credentials.deleteUrl(hostId);
			const current = this.record(hostId) ?? record;
			const previous = {
				nameOverride: current.nameOverride,
				proxyMode: current.proxyMode,
			};
			this.records.set(
				upsertRemoteHostRecord(this.records(), {
					...current,
					nameOverride,
					proxyMode: proxy?.mode,
				}),
			);
			try {
				await this.saveHostRecords();
			} catch (error) {
				const latest = this.record(hostId);
				if (latest?.deviceId === current.deviceId)
					this.records.set(
						upsertRemoteHostRecord(this.records(), { ...latest, ...previous }),
					);
				if (previousUrl !== null)
					await credentials.saveUrl(hostId, previousUrl);
				else if (proxy?.mode === "custom") await credentials.deleteUrl(hostId);
				throw error;
			}
		} finally {
			this.proxyEdits.delete(hostId);
		}

		if (this.disconnected().has(hostId)) return;
		const active = this.active() === hostId;
		this.bump(hostId);
		this.close(hostId);
		if (active) this.activate(hostId);
		else void this.connect(hostId);
	}

	private async updatePreference<K extends "shownInHome" | "nameOverride">(
		hostId: string,
		key: K,
		value: RemoteHostRecord[K],
	): Promise<void> {
		const record = this.record(hostId);
		if (!record || record[key] === value) return;
		const next = { ...record, [key]: value };
		this.records.set(upsertRemoteHostRecord(this.records(), next));
		try {
			await this.saveHostRecords();
		} catch (error) {
			const current = this.record(hostId);
			if (current?.deviceId === record.deviceId && current[key] === value) {
				this.records.set(
					upsertRemoteHostRecord(this.records(), {
						...current,
						[key]: record[key],
					}),
				);
			}
			throw error;
		}
	}

	private setPending(hostId: string, status: HostEntryStatus | null) {
		const next = new Map(this.pendingStatus());
		if (status) next.set(hostId, status);
		else next.delete(hostId);
		this.pendingStatus.set(next);
	}

	private bump(hostId: string): number {
		this.connecting.delete(hostId);
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
		fetchFn: FetchLike,
	): Promise<TokenCheck> {
		try {
			const response = await fetchFn(
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
		isCurrent: () => boolean,
		network: RemoteHostNetwork,
	): Promise<AddressSearch> {
		const { hostId } = record;
		let rateLimited = false;
		for (const address of remoteHostConnectOrder(record)) {
			// oxlint-disable-next-line no-await-in-loop -- Addresses are tried in order.
			const check = await this.checkToken(address, token, network.fetch);
			if (!isCurrent()) return { kind: "stale" };
			if (check === "unauthorized") return { kind: "unauthorized" };
			if (check === "rateLimited") rateLimited = true;
			if (check !== "ok") continue;
			let hello: HostHelloMessage | null = null;
			try {
				// oxlint-disable-next-line no-await-in-loop -- Addresses are tried in order.
				hello = await this.greet(address, token, network);
			} catch (error) {
				if (!isCurrent()) return { kind: "stale" };
				const code = error instanceof Error ? error.message : "";
				if (code === "REMOTE_HOST_UNAUTHORIZED")
					return { kind: "unauthorized" };
				if (code === "REMOTE_HOST_INCOMPATIBLE")
					return { kind: "incompatible" };
				continue;
			}
			if (!isCurrent()) return { kind: "stale" };
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

	/** Tests the saved pairing without opening or switching the window's session. */
	async test(hostId: string): Promise<HostEntryStatus> {
		const record = this.record(hostId);
		if (!record) return "offline";
		const current = () =>
			!this.closed && this.record(hostId)?.deviceId === record.deviceId;
		const token = await this.options.credentials.remoteHostToken(hostId);
		if (!token) return "unauthorized";
		const network = await this.savedNetwork(record);
		if (!current()) return "offline";
		const found = await this.findAddress(record, token, current, network);
		if (found.kind === "found") return "connected";
		if (found.kind === "unauthorized" || found.kind === "incompatible")
			return found.kind;
		return found.kind === "unreachable" && found.rateLimited
			? "rateLimited"
			: "offline";
	}

	/** Connects to a paired Host, sharing any address search already in flight. */
	connect(hostId: string): Promise<void> {
		const existing = this.connecting.get(hostId);
		if (existing) return existing;
		const attempt = this.connectRemote(hostId).finally(() => {
			if (this.connecting.get(hostId) === attempt)
				this.connecting.delete(hostId);
		});
		this.connecting.set(hostId, attempt);
		return attempt;
	}

	private async connectRemote(hostId: string): Promise<void> {
		const record = this.record(hostId);
		if (!record || this.connections().has(hostId) || this.closed) return;
		if (this.proxyEdits.has(hostId)) {
			this.scheduleRetry(hostId, false);
			return;
		}
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
		const network = await this.savedNetwork(record).catch(() => null);
		if (!this.isCurrent(hostId, generation)) return;
		if (!network) {
			this.setPending(hostId, "offline");
			this.scheduleRetry(hostId, false);
			return;
		}
		const found = await this.findAddress(
			record,
			token,
			() => this.isCurrent(hostId, generation),
			network,
		);
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
		this.open(current, found.address, token, generation, network);
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
			!this.proxyEdits.has(hostId) &&
			this.connections().get(hostId) === connection &&
			connection.state() !== "connected";
		const record = this.record(hostId);
		const token = await this.options.credentials
			.remoteHostToken(hostId)
			.catch(() => null);
		if (!record || !token || !live()) return;
		const found = await this.findAddress(
			record,
			token,
			live,
			connection.network,
		);
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
		network: RemoteHostNetwork,
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
			...network,
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
			network,
			access,
			state,
			startup: Promise.resolve().then(() => {
				if (owns()) return session.start();
			}),
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
		void connection.startup.catch((error: unknown) => {
			console.warn(`Failed to start the session of Host ${hostId}`, error);
		});
	}

	/** Disposes the Host's session in this window; the remote Host is not told to stop. */
	private close(hostId: string) {
		if (this.openingHostId() === hostId) this.activation.set(null);
		const connection = this.connections().get(hostId);
		if (!connection) return;
		const next = new Map(this.connections());
		next.delete(hostId);
		this.connections.set(next);
		connection.stop();
		connection.session.dispose();
		this.setRateLimited(hostId, false);
		if (this.active() === hostId) this.showHost(LOCAL_HOST_ID, false);
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
		if (this.openingHostId() === hostId) this.activation.set(null);
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
		const network =
			!revoked && token
				? (connection?.network ??
					(await this.savedNetwork(record).catch(() => null)))
				: null;
		if (network && token) {
			for (const address of remoteHostConnectOrder(record)) {
				try {
					// oxlint-disable-next-line no-await-in-loop -- Addresses are tried in order.
					const response = await network.fetch(
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
		if (record.proxyMode === "custom")
			await this.options.proxy?.deleteUrl(hostId);
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
		network: RemoteHostNetwork,
	): Promise<HostHelloMessage> {
		const transport = new HttpTransport({
			origin: address.baseUrl,
			tokens: { getToken: () => token },
			...network,
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
		/** Plain-http addresses the user agreed to. */
		plaintextAddressIds?: string[];
		proxy?: RemoteHostProxy;
	}): Promise<RemoteHostRecord> {
		const preferred =
			input.addresses.find(({ id }) => id === input.preferredAddressId) ??
			input.addresses[0];
		const hello = await this.greet(
			preferred,
			input.token,
			this.network(input.proxy),
		);
		const previous = this.record(hello.hostId);
		const record: RemoteHostRecord = {
			hostId: hello.hostId,
			name: hello.hostName,
			nameOverride: previous?.nameOverride,
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
			...(input.proxy ? { proxyMode: input.proxy.mode } : {}),
			shownInHome: previous?.shownInHome,
		};
		const { hostId } = record;
		if (this.proxyEdits.has(hostId))
			throw new Error("REMOTE_PROXY_CREDENTIALS_FAILED");
		this.proxyEdits.add(hostId);
		try {
			const proxy = input.proxy;
			const proxyCredentials =
				proxy?.mode === "custom" ? this.options.proxy : undefined;
			const previousUrl = proxyCredentials
				? await proxyCredentials.savedUrl(hostId)
				: null;
			if (proxy?.mode === "custom")
				await proxyCredentials?.saveUrl(hostId, proxy.url);
			try {
				await this.options.credentials.saveRemoteHostToken(hostId, input.token);
			} catch (error) {
				// The old pairing still owns this Host's credentials and session.
				if (previousUrl !== null)
					await proxyCredentials?.saveUrl(hostId, previousUrl);
				else await proxyCredentials?.deleteUrl(hostId);
				throw error;
			}
			this.bump(hostId);
			this.close(hostId);
			this.records.set(upsertRemoteHostRecord(this.records(), record));
			const disconnected = new Set(this.disconnected());
			disconnected.delete(hostId);
			this.disconnected.set(disconnected);
			await this.saveRecords();
			if (previous?.proxyMode === "custom" && record.proxyMode !== "custom") {
				await this.options.proxy?.deleteUrl(hostId).catch(() => undefined);
			}
		} finally {
			this.proxyEdits.delete(hostId);
		}
		await this.connect(hostId);
		return record;
	}

	/** Keeps the current workspace visible until the requested Host has loaded. */
	activate(hostId: string, { revealProjects = false } = {}) {
		if (this.closed || this.openingHostId() === hostId) return;
		if (hostId === this.active()) {
			this.activation.set(null);
			return;
		}
		if (hostId === LOCAL_HOST_ID) {
			this.activation.set(null);
			this.showHost(hostId, revealProjects);
			return;
		}
		const request = { hostId, revealProjects };
		this.activation.set(request);
		void this.activateRemote(request);
	}

	private showHost(hostId: string, revealProjects: boolean) {
		batch(() => {
			this.revealed.set(revealProjects ? hostId : null);
			this.active.set(hostId);
		});
	}

	private async activateRemote(request: {
		hostId: string;
		revealProjects: boolean;
	}) {
		const { hostId, revealProjects } = request;
		try {
			const existing = this.connections().get(hostId);
			if (!existing) await this.connect(hostId);
			const connection = this.connections().get(hostId);
			if (!connection || this.activation() !== request) return;
			const { store } = connection.session;
			if (existing === connection && store.state().status.type === "failed") {
				await store.retry();
			} else {
				await connection.startup;
			}
			if (
				this.activation() === request &&
				this.connections().get(hostId) === connection &&
				store.state().status.type === "ready"
			)
				this.showHost(hostId, revealProjects);
		} catch (error) {
			console.warn(`Failed to open the workspace of Host ${hostId}`, error);
		} finally {
			if (this.activation() === request) this.activation.set(null);
		}
	}

	/** On quit: closes every remote session and shuts down only the embedded Host. */
	async shutdown(): Promise<void> {
		this.closed = true;
		this.activation.set(null);
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
