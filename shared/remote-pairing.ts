import type { RemoteAccessAddress } from "./api/remote-types.ts";

export const PAIRING_CONTEXT_KEY = "pilo.remote.pairing-context.v1";
export const PAIRING_TTL_MS = 10 * 60 * 1_000;

export type RemotePairingAddress = RemoteAccessAddress & { issued: boolean };

export type RemotePairingInfo = {
	addresses: RemotePairingAddress[];
	expiresAtMs: number;
	remainingUses: number;
};

export type PairingContext = {
	secret: string;
	addressId: string | null;
	entryAddressId: string | null;
	requestId: string | null;
	expiresAtMs: number;
};

export type PairingBoot = {
	context: PairingContext | null;
	target: boolean;
	error: string | null;
};

export type PairingStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
}

export function decodePairingContext(value: unknown): PairingContext | null {
	if (!isRecord(value)) return null;
	const secret = value.secret;
	const addressId = value.addressId;
	const entryAddressId = value.entryAddressId;
	const requestId = value.requestId;
	const expiresAtMs = value.expiresAtMs;
	if (
		typeof secret !== "string" ||
		!/^[a-zA-Z0-9_-]{43}$/.test(secret) ||
		(addressId !== null && !validId(addressId)) ||
		(entryAddressId !== null && !validId(entryAddressId)) ||
		(requestId !== null &&
			(typeof requestId !== "string" || !/^[a-f0-9]{64}$/.test(requestId))) ||
		typeof expiresAtMs !== "number" ||
		!Number.isSafeInteger(expiresAtMs)
	) {
		return null;
	}
	return { secret, addressId, entryAddressId, requestId, expiresAtMs };
}

export function isRemotePairingUrl(rawUrl: string | null | undefined): boolean {
	if (!rawUrl) return false;
	try {
		const url = new URL(rawUrl);
		return (
			/^\/pair(?:\/complete)?\/?$/.test(url.pathname) ||
			new URLSearchParams(url.hash.slice(1)).has("pair") ||
			url.searchParams.has("pair")
		);
	} catch {
		return false;
	}
}

export function readPairingContext(
	storage: PairingStorage | undefined,
	now = Date.now(),
): PairingContext | null {
	if (!storage) throw new Error("REMOTE_PAIRING_STORAGE_UNAVAILABLE");
	try {
		const raw = storage.getItem(PAIRING_CONTEXT_KEY);
		if (!raw) return null;
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			storage.removeItem(PAIRING_CONTEXT_KEY);
			return null;
		}
		const context = decodePairingContext(value);
		if (!context) {
			storage.removeItem(PAIRING_CONTEXT_KEY);
			return null;
		}
		if (context.expiresAtMs > now) return context;
		storage.removeItem(PAIRING_CONTEXT_KEY);
	} catch {
		throw new Error("REMOTE_PAIRING_STORAGE_UNAVAILABLE");
	}
	throw new Error("REMOTE_PAIRING_EXPIRED");
}

export function savePairingContext(
	storage: PairingStorage | undefined,
	context: PairingContext,
): void {
	if (!storage) throw new Error("REMOTE_PAIRING_STORAGE_UNAVAILABLE");
	try {
		storage.setItem(PAIRING_CONTEXT_KEY, JSON.stringify(context));
	} catch {
		throw new Error("REMOTE_PAIRING_STORAGE_UNAVAILABLE");
	}
}

export function refreshPairingContext(
	storage: PairingStorage | undefined,
	context: PairingContext,
	now = Date.now(),
): PairingContext {
	const stored = readPairingContext(storage, now);
	const next: PairingContext = {
		...context,
		requestId:
			context.requestId ??
			(stored?.secret === context.secret &&
			stored.addressId === context.addressId
				? stored.requestId
				: null),
	};
	savePairingContext(storage, next);
	return next;
}

export function clearPairingContext(storage: PairingStorage | undefined): void {
	try {
		storage?.removeItem(PAIRING_CONTEXT_KEY);
	} catch {
		// Storage may be blocked.
	}
}

export function capturePairingBootFromUrl(
	rawUrl: string,
	storage: PairingStorage | undefined,
	replacePath: (pathname: string) => void,
	now = Date.now(),
): PairingBoot {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return {
			context: null,
			target: false,
			error: "REMOTE_PAIRING_INVALID_LINK",
		};
	}
	const target = parsed.pathname.replace(/\/$/, "") === "/pair/complete";
	const fragment = new URLSearchParams(parsed.hash.slice(1));
	const secret = fragment.get("pair") ?? parsed.searchParams.get("pair");
	try {
		let previous: PairingContext | null;
		try {
			previous = readPairingContext(storage, now);
		} catch (error) {
			// A fresh scan can replace expired context, but never bypass blocked storage.
			if (
				secret === null ||
				!(error instanceof Error) ||
				error.message !== "REMOTE_PAIRING_EXPIRED"
			) {
				throw error;
			}
			previous = null;
		}
		if (secret === null) return { context: previous, target, error: null };
		const matchingPrevious =
			previous !== null && previous.secret === secret ? previous : null;
		// Reopening the selection link must not erase this origin's retry proof.
		const addressId = target
			? fragment.get("address")
			: (matchingPrevious?.addressId ?? null);
		const entryAddressId = fragment.get("entry");
		const context = decodePairingContext({
			secret,
			addressId,
			entryAddressId,
			requestId:
				matchingPrevious && matchingPrevious.addressId === addressId
					? matchingPrevious.requestId
					: null,
			expiresAtMs: matchingPrevious
				? matchingPrevious.expiresAtMs
				: now + PAIRING_TTL_MS,
		});
		if (!context || (target && !addressId)) {
			throw new Error("REMOTE_PAIRING_INVALID_LINK");
		}
		savePairingContext(storage, context);
		return { context, target, error: null };
	} catch (error) {
		return {
			context: null,
			target,
			error:
				error instanceof Error ? error.message : "REMOTE_PAIRING_INVALID_LINK",
		};
	} finally {
		if (secret !== null) replacePath(target ? "/pair/complete" : "/pair");
	}
}

export function preparePairingRequest(
	storage: PairingStorage | undefined,
	context: PairingContext,
	randomBytes: (size: number) => Uint8Array,
	now = Date.now(),
): PairingContext & { requestId: string } {
	const stored = readPairingContext(storage, now);
	const requestId =
		stored?.secret === context.secret && stored.addressId === context.addressId
			? stored.requestId
			: null;
	if (requestId) {
		const next = { ...context, requestId };
		savePairingContext(storage, next);
		return next;
	}
	const bytes = randomBytes(32);
	if (bytes.length !== 32) {
		throw new Error("REMOTE_PAIRING_RANDOM_UNAVAILABLE");
	}
	const next = {
		...context,
		requestId: Array.from(bytes, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join(""),
	};
	savePairingContext(storage, next);
	return next;
}

export function pairingTargetAddress(
	addresses: readonly RemoteAccessAddress[],
	addressId: string | null,
	targetPage: boolean,
	origin: string,
): RemoteAccessAddress | null {
	if (!targetPage && addresses.length !== 1) return null;
	const target = targetPage
		? addresses.find((address) => address.id === addressId)
		: addresses[0];
	if (!target || target.baseUrl !== origin) {
		throw new Error("REMOTE_PAIRING_INVALID_LINK");
	}
	return target;
}

export function pairingTargetUrl(
	address: RemoteAccessAddress,
	context: PairingContext,
	entryAddressId: string,
): string {
	const url = new URL("/pair/complete", address.baseUrl);
	url.hash = new URLSearchParams({
		pair: context.secret,
		address: address.id,
		entry: entryAddressId,
	}).toString();
	return url.href;
}

export function pairingReturnUrl(address: RemoteAccessAddress): string {
	return new URL("/pair", address.baseUrl).href;
}

export function parseRemotePairingInfo(value: unknown): RemotePairingInfo {
	if (
		!isRecord(value) ||
		!Array.isArray(value.addresses) ||
		typeof value.expiresAtMs !== "number" ||
		!Number.isSafeInteger(value.expiresAtMs) ||
		typeof value.remainingUses !== "number" ||
		!Number.isSafeInteger(value.remainingUses)
	) {
		throw new Error("REMOTE_PAIRING_INVALID_RESPONSE");
	}
	const addresses = value.addresses.map(
		(address: unknown): RemotePairingAddress => {
			if (
				!isRecord(address) ||
				typeof address.id !== "string" ||
				!/^[a-zA-Z0-9-]{1,80}$/.test(address.id) ||
				typeof address.name !== "string" ||
				typeof address.baseUrl !== "string" ||
				typeof address.issued !== "boolean"
			) {
				throw new Error("REMOTE_PAIRING_INVALID_RESPONSE");
			}
			const url = new URL(address.baseUrl);
			if (!/^https?:$/.test(url.protocol) || url.origin !== address.baseUrl) {
				throw new Error("REMOTE_PAIRING_INVALID_RESPONSE");
			}
			return {
				id: address.id,
				name: address.name,
				baseUrl: address.baseUrl,
				issued: address.issued,
			};
		},
	);
	if (
		!addresses.length ||
		addresses.length > 32 ||
		value.remainingUses < 0 ||
		value.remainingUses > addresses.length ||
		new Set(addresses.map((address) => address.id)).size !== addresses.length
	) {
		throw new Error("REMOTE_PAIRING_INVALID_RESPONSE");
	}
	return {
		addresses,
		expiresAtMs: value.expiresAtMs,
		remainingUses: value.remainingUses,
	};
}

export function parseRemotePairResponse(
	value: unknown,
	now = Date.now(),
): { token: string; expiresAtMs: number } {
	if (
		!isRecord(value) ||
		typeof value.token !== "string" ||
		!/^[a-zA-Z0-9_-]{43}$/.test(value.token) ||
		!isRecord(value.device) ||
		typeof value.device.id !== "string" ||
		typeof value.device.expiresAtMs !== "number" ||
		!Number.isSafeInteger(value.device.expiresAtMs) ||
		value.device.expiresAtMs <= now
	) {
		throw new Error("REMOTE_PAIRING_INVALID_RESPONSE");
	}
	return { token: value.token, expiresAtMs: value.device.expiresAtMs };
}

export function parseDeviceAuthResponse(value: unknown): {
	expiresAtMs: number;
} {
	if (
		!isRecord(value) ||
		typeof value.expiresAtMs !== "number" ||
		!Number.isSafeInteger(value.expiresAtMs)
	) {
		throw new Error("REMOTE_DEVICE_INVALID_RESPONSE");
	}
	return { expiresAtMs: value.expiresAtMs };
}
