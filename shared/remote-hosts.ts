import type { HostTransportConnectionState } from "./api/host-transport";
import type { RemoteAccessAddress, RemoteScopes } from "./api/remote-types";

/** A remote Pilo Host this desktop paired with; its token lives in the system credential store. */
export type RemoteHostRecord = {
	hostId: string;
	name: string;
	addresses: RemoteAccessAddress[];
	preferredAddressId: string;
	deviceId: string;
	/** The scopes granted at pairing, until a hello reports the current ones. */
	scopes: RemoteScopes;
	/** The Host's platform as its last hello reported (`macos`, `windows`, `linux`). */
	platform?: string;
	/** Plain-http addresses outside private networks the user agreed to connect through. */
	plaintextAddressIds?: string[];
};

export const REMOTE_HOSTS_STORAGE_KEY = "pilo.remoteHosts.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAddress(value: unknown): RemoteAccessAddress | null {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		!value.id ||
		typeof value.name !== "string" ||
		typeof value.baseUrl !== "string"
	) {
		return null;
	}
	try {
		const url = new URL(value.baseUrl);
		if (!/^https?:$/.test(url.protocol)) return null;
		return { id: value.id, name: value.name, baseUrl: url.origin };
	} catch {
		return null;
	}
}

function parseRecord(value: unknown): RemoteHostRecord | null {
	if (
		!isRecord(value) ||
		typeof value.hostId !== "string" ||
		!value.hostId ||
		typeof value.name !== "string" ||
		typeof value.deviceId !== "string" ||
		!Array.isArray(value.addresses)
	) {
		return null;
	}
	const addresses = value.addresses
		.map(parseAddress)
		.filter((address): address is RemoteAccessAddress => address !== null);
	if (!addresses.length) return null;
	const preferredAddressId =
		typeof value.preferredAddressId === "string" &&
		addresses.some((address) => address.id === value.preferredAddressId)
			? value.preferredAddressId
			: addresses[0].id;
	return {
		hostId: value.hostId,
		name: value.name,
		addresses,
		preferredAddressId,
		deviceId: value.deviceId,
		scopes: value.scopes === "chat,workspace" ? "chat,workspace" : "chat",
		...(typeof value.platform === "string" ? { platform: value.platform } : {}),
		...(Array.isArray(value.plaintextAddressIds)
			? {
					plaintextAddressIds: value.plaintextAddressIds.filter(
						(id): id is string =>
							typeof id === "string" &&
							addresses.some((address) => address.id === id),
					),
				}
			: {}),
	};
}

/** Reads the saved records, skipping malformed and duplicate entries. */
export function parseRemoteHostRecords(raw: string | null): RemoteHostRecord[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const seen = new Set<string>();
	const records: RemoteHostRecord[] = [];
	for (const item of parsed) {
		const record = parseRecord(item);
		if (!record || seen.has(record.hostId)) continue;
		seen.add(record.hostId);
		records.push(record);
	}
	return records;
}

export function serializeRemoteHostRecords(
	records: readonly RemoteHostRecord[],
): string {
	return JSON.stringify(records);
}

/** Replaces the record with the same Host id in place, or appends it. */
export function upsertRemoteHostRecord(
	records: readonly RemoteHostRecord[],
	record: RemoteHostRecord,
): RemoteHostRecord[] {
	const index = records.findIndex((item) => item.hostId === record.hostId);
	if (index === -1) return [...records, record];
	return records.map((item, i) => (i === index ? record : item));
}

/** The addresses to try, in order: the preferred one, then the rest as saved. */
export function remoteHostAddressOrder(
	record: Pick<RemoteHostRecord, "addresses" | "preferredAddressId">,
): RemoteAccessAddress[] {
	const preferred = record.addresses.find(
		(address) => address.id === record.preferredAddressId,
	);
	return preferred
		? [
				preferred,
				...record.addresses.filter((address) => address !== preferred),
			]
		: [...record.addresses];
}

function isPrivateIpv4(host: string): boolean {
	const octets = host.split(".").map(Number);
	if (
		octets.length !== 4 ||
		!octets.every(
			(octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
		)
	) {
		return false;
	}
	const [a, b] = octets;
	return (
		a === 10 ||
		a === 127 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254)
	);
}

function isPrivateIpv6(host: string): boolean {
	const address = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (!address.includes(":")) return false;
	return (
		address === "::1" ||
		/^f[cd][0-9a-f]{2}:/.test(address) ||
		/^fe[89ab][0-9a-f]:/.test(address)
	);
}

/** Loopback, RFC 1918, link-local and unique-local addresses, `localhost` and mDNS `.local` names. */
export function isPrivateLanHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return (
		host === "localhost" ||
		host.endsWith(".local") ||
		isPrivateIpv4(host) ||
		isPrivateIpv6(host)
	);
}

/** Whether traffic to the address would cross a network in plain text. */
export function isPlaintextRemoteAddress(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.protocol === "http:" && !isPrivateLanHost(url.hostname);
	} catch {
		return false;
	}
}

/**
 * The addresses to connect through, in order: the preferred one, then the
 * rest, skipping plain-http addresses outside private networks the user did
 * not agree to when pairing.
 */
export function remoteHostConnectOrder(
	record: Pick<
		RemoteHostRecord,
		"addresses" | "preferredAddressId" | "plaintextAddressIds"
	>,
): RemoteAccessAddress[] {
	const allowed = new Set(record.plaintextAddressIds ?? []);
	return remoteHostAddressOrder(record).filter(
		(address, index) =>
			index === 0 ||
			allowed.has(address.id) ||
			!isPlaintextRemoteAddress(address.baseUrl),
	);
}

export type DesktopPairingLink = {
	/** The address the link was opened from: its origin. */
	entryOrigin: string;
	secret: string;
	addressId: string | null;
};

/** Reads a `<entry>/pair#pair=<secret>` link a Host's settings show. */
export function parseDesktopPairingLink(input: string): DesktopPairingLink {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new Error("REMOTE_PAIRING_INVALID_LINK");
	}
	if (
		!/^https?:$/.test(url.protocol) ||
		!/^\/pair(?:\/complete)?\/?$/.test(url.pathname)
	) {
		throw new Error("REMOTE_PAIRING_INVALID_LINK");
	}
	const params = new URLSearchParams(url.hash.replace(/^#/, ""));
	const secret = params.get("pair") ?? "";
	if (!/^[A-Za-z0-9_-]{16,128}$/.test(secret)) {
		throw new Error("REMOTE_PAIRING_INVALID_LINK");
	}
	return {
		entryOrigin: url.origin,
		secret,
		addressId: params.get("address"),
	};
}

/** The pairing name a Host lists this desktop under. */
export function desktopDeviceName(machineName: string | null | undefined) {
	const name = machineName?.trim().replace(/\s+/g, " ").slice(0, 60);
	return name ? `${name} · Pilo Desktop` : "Pilo Desktop";
}

export type RemoteHostStatus =
	| "connected"
	| "connecting"
	| "offline"
	| "unauthorized"
	| "incompatible"
	/** The Host is turning this device's requests away for now; retried with backoff. */
	| "rateLimited";

/** How long a dropped connection shows "connecting" before it shows offline. */
export const REMOTE_HOST_OFFLINE_AFTER_MS = 4_000;

/**
 * A remote Host's sidebar status: a reconnect that has not come back within
 * `REMOTE_HOST_OFFLINE_AFTER_MS` (the Host turned remote access off, or is
 * unreachable) shows offline while the transport keeps retrying.
 */
export function resolveRemoteHostStatus(
	state: HostTransportConnectionState,
	disconnectedForMs: number,
): RemoteHostStatus {
	switch (state) {
		case "connected":
			return "connected";
		case "unauthorized":
			return "unauthorized";
		case "incompatible":
			return "incompatible";
		case "offline":
			return "offline";
		case "connecting":
		case "reconnecting":
			return disconnectedForMs >= REMOTE_HOST_OFFLINE_AFTER_MS
				? "offline"
				: "connecting";
	}
}

export function hasRemoteScope(
	scopes: RemoteScopes | null | undefined,
	scope: "chat" | "workspace",
): boolean {
	return (scopes ?? "").split(",").includes(scope);
}
