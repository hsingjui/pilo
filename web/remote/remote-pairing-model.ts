import type { RemoteAccessAddress } from "@shared/api/remote-types";

const CONTEXT_KEY = "pilo.remote.pairing-context.v1";
const PAIRING_TTL_MS = 10 * 60 * 1_000;

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

function validId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
}

function decodeContext(value: unknown): PairingContext | null {
	if (typeof value !== "object" || value === null) return null;
	const secret = Reflect.get(value, "secret");
	const addressId = Reflect.get(value, "addressId");
	const entryAddressId = Reflect.get(value, "entryAddressId");
	const requestId = Reflect.get(value, "requestId");
	const expiresAtMs = Reflect.get(value, "expiresAtMs");
	if (
		typeof secret !== "string" ||
		!/^[a-zA-Z0-9_-]{43}$/.test(secret) ||
		(addressId !== null && !validId(addressId)) ||
		(entryAddressId !== null && !validId(entryAddressId)) ||
		(requestId !== null &&
			(typeof requestId !== "string" || !/^[a-f0-9]{64}$/.test(requestId))) ||
		typeof expiresAtMs !== "number" ||
		!Number.isSafeInteger(expiresAtMs)
	)
		return null;
	return { secret, addressId, entryAddressId, requestId, expiresAtMs };
}

function readContext(): PairingContext | null {
	try {
		const raw = window.sessionStorage.getItem(CONTEXT_KEY);
		if (!raw) return null;
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			window.sessionStorage.removeItem(CONTEXT_KEY);
			return null;
		}
		const context = decodeContext(value);
		if (!context) {
			window.sessionStorage.removeItem(CONTEXT_KEY);
			return null;
		}
		if (context.expiresAtMs > Date.now()) return context;
		window.sessionStorage.removeItem(CONTEXT_KEY);
	} catch {
		throw new Error("REMOTE_PAIRING_STORAGE_UNAVAILABLE");
	}
	throw new Error("REMOTE_PAIRING_EXPIRED");
}

export function savePairingContext(context: PairingContext) {
	try {
		window.sessionStorage.setItem(CONTEXT_KEY, JSON.stringify(context));
	} catch {
		throw new Error("REMOTE_PAIRING_STORAGE_UNAVAILABLE");
	}
}

export function refreshPairingContext(context: PairingContext): PairingContext {
	const stored = readContext();
	const next = {
		...context,
		requestId:
			context.requestId ??
			(stored?.secret === context.secret &&
			stored.addressId === context.addressId
				? stored.requestId
				: null),
	};
	savePairingContext(next);
	return next;
}

export function clearPairingContext() {
	try {
		window.sessionStorage.removeItem(CONTEXT_KEY);
	} catch {
		/* Storage may be blocked. */
	}
}

export function isRemotePairingLocation() {
	return (
		/^\/pair(?:\/complete)?\/?$/.test(window.location.pathname) ||
		new URLSearchParams(window.location.hash.slice(1)).has("pair") ||
		new URLSearchParams(window.location.search).has("pair")
	);
}

export function capturePairingBoot(): PairingBoot {
	const target =
		window.location.pathname.replace(/\/$/, "") === "/pair/complete";
	const fragment = new URLSearchParams(window.location.hash.slice(1));
	const query = new URLSearchParams(window.location.search);
	const secret = fragment.get("pair") ?? query.get("pair");
	try {
		let previous: PairingContext | null;
		try {
			previous = readContext();
		} catch (error) {
			// A fresh scan can replace expired context, but never bypass blocked storage.
			if (
				secret === null ||
				!(error instanceof Error) ||
				error.message !== "REMOTE_PAIRING_EXPIRED"
			)
				throw error;
			previous = null;
		}
		if (secret === null) return { context: previous, target, error: null };
		// Reopening the selection link must not erase this origin's retry proof.
		const addressId = target
			? fragment.get("address")
			: previous?.secret === secret
				? previous.addressId
				: null;
		const entryAddressId = fragment.get("entry");
		const context = decodeContext({
			secret,
			addressId,
			entryAddressId,
			requestId:
				previous?.secret === secret && previous.addressId === addressId
					? previous.requestId
					: null,
			expiresAtMs:
				previous?.secret === secret
					? previous.expiresAtMs
					: Date.now() + PAIRING_TTL_MS,
		});
		if (!context || (target && !addressId))
			throw new Error("REMOTE_PAIRING_INVALID_LINK");
		savePairingContext(context);
		return { context, target, error: null };
	} catch (error) {
		return {
			context: null,
			target,
			error:
				error instanceof Error ? error.message : "REMOTE_PAIRING_INVALID_LINK",
		};
	} finally {
		if (secret !== null)
			window.history.replaceState({}, "", target ? "/pair/complete" : "/pair");
	}
}

export function preparePairingRequest(
	context: PairingContext,
): PairingContext & { requestId: string } {
	const stored = readContext();
	const requestId =
		stored?.secret === context.secret && stored.addressId === context.addressId
			? stored.requestId
			: null;
	if (requestId) {
		const next = { ...context, requestId };
		savePairingContext(next);
		return next;
	}
	if (typeof window.crypto?.getRandomValues !== "function")
		throw new Error("REMOTE_PAIRING_RANDOM_UNAVAILABLE");
	const bytes = window.crypto.getRandomValues(new Uint8Array(32));
	const next = {
		...context,
		requestId: Array.from(bytes, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join(""),
	};
	savePairingContext(next);
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
	if (!target || target.baseUrl !== origin)
		throw new Error("REMOTE_PAIRING_INVALID_LINK");
	return target;
}

export function pairingTargetUrl(
	address: RemoteAccessAddress,
	context: PairingContext,
	entryAddressId: string,
) {
	const url = new URL("/pair/complete", address.baseUrl);
	url.hash = new URLSearchParams({
		pair: context.secret,
		address: address.id,
		entry: entryAddressId,
	}).toString();
	return url.href;
}

export function pairingReturnUrl(address: RemoteAccessAddress) {
	return new URL("/pair", address.baseUrl).href;
}
