import { Storage, UrlScheme } from "nsh";

import { describeDevice } from "@shared/device-name";
import { type KeyValueStorage, readMigratedStorageSync } from "@shared/host-id";
import {
	parseRemotePairResponse,
	parseRemotePairingInfo,
	type RemotePairingInfo,
} from "@shared/remote-pairing";

export const REMOTE_TOKEN_KEY = "pilo.remote.device-token.v1";

export class RemotePairingError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "RemotePairingError";
	}
}

type BrowserGlobal = {
	localStorage?: KeyValueStorage;
	sessionStorage?: KeyValueStorage & {
		readonly length: number;
		key(index: number): string | null;
	};
	parent?: Pick<BrowserGlobal, "location">;
	location?: {
		href?: string;
		assign?: (url: string) => void;
		replace?: (url: string) => void;
		reload?: () => void;
	};
	navigator?: { onLine?: boolean; userAgent?: string };
	crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array };
	addEventListener?: (type: string, listener: () => void) => void;
	removeEventListener?: (type: string, listener: () => void) => void;
};

export function browserGlobal(): BrowserGlobal {
	return globalThis as unknown as BrowserGlobal;
}

function browserPageLocation(): BrowserGlobal["location"] {
	const browser = browserGlobal();
	try {
		// nsh runs app code in a hidden iframe; use the hosting page's address.
		const parentLocation = browser.parent?.location;
		if (parentLocation?.href) return parentLocation;
	} catch {
		// A cross-origin parent does not expose its address.
	}
	return browser.location;
}

export function readBrowserLocalStorage(
	key: string,
	...legacyKeys: string[]
): string | null {
	try {
		const storage = browserGlobal().localStorage;
		return storage
			? readMigratedStorageSync(storage, key, ...legacyKeys)
			: null;
	} catch {
		return null;
	}
}

export function writeBrowserLocalStorage(key: string, value: string): void {
	try {
		browserGlobal().localStorage?.setItem(key, value);
	} catch {
		// Sandboxed realms or private mode may refuse localStorage.
	}
}

function removeBrowserLocalStorage(key: string): void {
	try {
		browserGlobal().localStorage?.removeItem(key);
	} catch {
		// Ignore storage cleanup failures.
	}
}

/**
 * Resolves the paired device token from URL hash (`#token=...`), same-origin
 * `localStorage` (shared with the React WebUI), or nsh's own `Storage`.
 */
export async function loadRemoteDeviceToken(): Promise<string | null> {
	try {
		const parsed = resolvePageAddress();
		const params = new URLSearchParams(parsed.hash.slice(1));
		const hashToken = params.get("token")?.trim();
		if (hashToken) {
			params.delete("token");
			const remaining = params.toString();
			parsed.hash = remaining ? `#${remaining}` : "";
			try {
				UrlScheme.setUrl(parsed.href, { history: "replace" });
			} catch {
				// Ignore if the host rejects URL mutation.
			}
			await saveRemoteDeviceToken(hashToken);
			return hashToken;
		}
	} catch {
		// Fall back to stored credentials if URL token handling fails.
	}

	const shared = readBrowserLocalStorage(REMOTE_TOKEN_KEY)?.trim();
	if (shared) {
		void Storage.setItem(REMOTE_TOKEN_KEY, shared).catch(() => undefined);
		return shared;
	}

	const stored = (
		await Storage.getItem(REMOTE_TOKEN_KEY).catch(() => null)
	)?.trim();
	if (stored) {
		writeBrowserLocalStorage(REMOTE_TOKEN_KEY, stored);
		return stored;
	}

	return null;
}

export async function saveRemoteDeviceToken(token: string): Promise<void> {
	const trimmed = token.trim();
	if (!trimmed) return;
	writeBrowserLocalStorage(REMOTE_TOKEN_KEY, trimmed);
	await Storage.setItem(REMOTE_TOKEN_KEY, trimmed).catch(() => undefined);
}

export async function clearRemoteDeviceToken(
	expectedToken?: string,
): Promise<void> {
	const currentShared = readBrowserLocalStorage(REMOTE_TOKEN_KEY);
	if (!expectedToken || currentShared === expectedToken) {
		removeBrowserLocalStorage(REMOTE_TOKEN_KEY);
	}
	const currentStored = await Storage.getItem(REMOTE_TOKEN_KEY).catch(
		() => null,
	);
	if (!expectedToken || currentStored === expectedToken) {
		await Storage.removeItem(REMOTE_TOKEN_KEY).catch(() => undefined);
	}
}

function parseHttpPageUrl(value: string | null | undefined): URL | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol === "http:" || url.protocol === "https:") return url;
	} catch {
		// Ignore invalid addresses.
	}
	return undefined;
}

function resolvePageAddress(): URL {
	const browserUrl = parseHttpPageUrl(browserPageLocation()?.href);
	const appUrl = parseHttpPageUrl(UrlScheme.url());
	// setUrl updates the app address before the browser history catches up.
	if (appUrl && (!browserUrl || appUrl.origin === browserUrl.origin)) {
		return appUrl;
	}
	return browserUrl ?? new URL("http://127.0.0.1:47653/");
}

export function resolveCurrentPageUrl(): string {
	return resolvePageAddress().href;
}

export function resolvePageOrigin(): string {
	return resolvePageAddress().origin;
}

export function navigateToUrl(
	url: string,
	options?: { replace?: boolean },
): void {
	const location = browserPageLocation();
	if (options?.replace && location?.replace) {
		location.replace(url);
		return;
	}
	if (location?.assign) {
		location.assign(url);
		return;
	}
	try {
		UrlScheme.setUrl(url, { history: options?.replace ? "replace" : "push" });
	} catch {
		// Ignore when running outside a browser host.
	}
}

export function reloadRemotePage(): void {
	browserPageLocation()?.reload?.();
}

export function browserSessionStorage(): BrowserGlobal["sessionStorage"] {
	try {
		return browserGlobal().sessionStorage;
	} catch {
		return undefined;
	}
}

export function browserRandomBytes(size: number): Uint8Array {
	const getRandomValues = browserGlobal().crypto?.getRandomValues;
	if (typeof getRandomValues !== "function") {
		throw new Error("REMOTE_PAIRING_RANDOM_UNAVAILABLE");
	}
	return getRandomValues.call(browserGlobal().crypto, new Uint8Array(size));
}

export function isBrowserOnline(): boolean {
	const onLine = browserGlobal().navigator?.onLine;
	return typeof onLine === "boolean" ? onLine : true;
}

export async function decodeError(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: string };
		return body.error || response.statusText || `HTTP ${response.status}`;
	} catch {
		return response.statusText || `HTTP ${response.status}`;
	}
}

async function pairingRequest(
	path: string,
	body: object,
	origin = resolvePageOrigin(),
): Promise<unknown> {
	const response = await fetch(new URL(path, origin).href, {
		method: "POST",
		cache: "no-store",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new RemotePairingError(response.status, await decodeError(response));
	}
	return response.json();
}

export async function getRemotePairingInfo(
	secret: string,
	origin = resolvePageOrigin(),
): Promise<RemotePairingInfo> {
	return parseRemotePairingInfo(
		await pairingRequest("/api/v1/auth/pairing", { secret }, origin),
	);
}

export async function pairRemote(
	secret: string,
	addressId: string,
	requestId: string,
	origin = resolvePageOrigin(),
): Promise<{ token: string; expiresAtMs: number }> {
	const ua = browserGlobal().navigator?.userAgent ?? "";
	return parseRemotePairResponse(
		await pairingRequest(
			"/api/v1/auth/pair",
			{
				secret,
				addressId,
				requestId,
				deviceName: describeDevice(ua),
			},
			origin,
		),
	);
}

export async function verifyRemoteToken(
	token: string,
	origin = resolvePageOrigin(),
): Promise<void> {
	const response = await fetch(new URL("/api/v1/auth/device", origin).href, {
		cache: "no-store",
		headers: { authorization: `Bearer ${token}` },
	});
	if (response.status === 401) {
		await clearRemoteDeviceToken(token);
		throw new Error("REMOTE_AUTH_EXPIRED");
	}
	if (!response.ok) throw new Error(await decodeError(response));
}
