import type { FetchLike } from "@shared/api/host-transport";
import type {
	RemoteAccessAddress,
	RemoteScopes,
} from "@shared/api/remote-types";
import {
	parseRemotePairingInfo,
	parseRemotePairResponse,
	type RemotePairingInfo,
} from "@shared/remote-pairing";
import type { DesktopPairingLink } from "@shared/remote-hosts";

export type DesktopPairResult = {
	token: string;
	deviceId: string;
	scopes: RemoteScopes;
	expiresAtMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function postJson(
	fetchFn: FetchLike,
	url: string,
	body: unknown,
): Promise<unknown> {
	const response = await fetchFn(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	});
	const text = await response.text();
	let parsed: unknown = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = null;
	}
	if (!response.ok) {
		const message =
			isRecord(parsed) && typeof parsed.error === "string"
				? parsed.error
				: `HTTP ${response.status}`;
		throw new Error(message);
	}
	return parsed;
}

function parseScopes(value: unknown): RemoteScopes {
	return value === "chat,workspace" ? "chat,workspace" : "chat";
}

/** Reads the access addresses offered by a Host's pairing link. */
export async function readDesktopPairingInfo(
	link: DesktopPairingLink,
	fetchFn: FetchLike,
): Promise<RemotePairingInfo> {
	const value = await postJson(
		fetchFn,
		`${link.entryOrigin}/api/v1/auth/pairing`,
		{ secret: link.secret },
	);
	return parseRemotePairingInfo(value);
}

/** Tests the chosen route without sending the pairing secret or a device token. */
export async function testDesktopProxy(
	origin: string,
	fetchFn: FetchLike,
): Promise<void> {
	const response = await fetchFn(`${origin}/api/v2/health`, {
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error("REMOTE_PROXY_REQUEST_FAILED");
	const value: unknown = await response.json().catch(() => null);
	if (!isRecord(value) || value.ok !== true || value.service !== "pilo-remote")
		throw new Error("REMOTE_PROXY_NOT_PILO");
}

export function createDesktopPairingRequestId(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

/** Exchanges the link's secret for this desktop's device token at the chosen address. */
export async function pairDesktop(
	link: DesktopPairingLink,
	address: RemoteAccessAddress,
	deviceName: string,
	requestId: string,
	fetchFn: FetchLike,
): Promise<DesktopPairResult> {
	const value = await postJson(fetchFn, `${address.baseUrl}/api/v1/auth/pair`, {
		secret: link.secret,
		addressId: address.id,
		requestId,
		deviceName,
	});
	const { token, expiresAtMs } = parseRemotePairResponse(value);
	const device = isRecord(value) && isRecord(value.device) ? value.device : {};
	return {
		token,
		expiresAtMs,
		deviceId: typeof device.id === "string" ? device.id : "",
		scopes: parseScopes(device.scopes),
	};
}
