import { invoke } from "@tauri-apps/api/core";

export type RemoteDevice = {
	id: string;
	name: string;
	pairIp: string;
	createdAtMs: number;
	lastSeenAtMs: number;
	expiresAtMs: number;
	revokedAtMs: number | null;
};

export type RemoteAccessAddress = {
	id: string;
	name: string;
	baseUrl: string;
};

export type RemoteHostState = {
	enabled: boolean;
	running: boolean;
	port: number;
	baseUrl: string | null;
	publicBaseUrl: string;
	addresses: RemoteAccessAddress[];
	entryAddressId: string;
	addressConfigError: string | null;
	pairingRemainingUses: number;
	pairingTotalUses: number;
	pairingUrl: string | null;
	pairingExpiresAtMs: number | null;
	lastError: string | null;
	devices: RemoteDevice[];
};

export function getRemoteHostState(): Promise<RemoteHostState> {
	return invoke<RemoteHostState>("remote_host_state");
}

export function getRemoteLanAddresses(): Promise<string[]> {
	return invoke<string[]>("remote_lan_addresses");
}

export function setRemoteEnabled(enabled: boolean): Promise<RemoteHostState> {
	return invoke<RemoteHostState>("remote_set_enabled", { enabled });
}

export function setRemotePort(port: number): Promise<RemoteHostState> {
	return invoke<RemoteHostState>("remote_set_port", { port });
}

export function setRemotePublicBaseUrl(
	publicBaseUrl: string,
): Promise<RemoteHostState> {
	return invoke<RemoteHostState>("remote_set_public_base_url", {
		publicBaseUrl,
	});
}

export function setRemoteAddresses(
	addresses: RemoteAccessAddress[],
	entryAddressId: string,
): Promise<RemoteHostState> {
	return invoke<RemoteHostState>("remote_set_addresses", {
		addresses,
		entryAddressId,
	});
}

export function regenerateRemotePairing(): Promise<RemoteHostState> {
	return invoke<RemoteHostState>("remote_pairing_regenerate");
}

export function revokeRemoteDevice(deviceId: string): Promise<RemoteHostState> {
	return invoke<RemoteHostState>("remote_device_revoke", { deviceId });
}

export function renameRemoteDevice(
	deviceId: string,
	name: string,
): Promise<RemoteHostState> {
	return invoke<RemoteHostState>("remote_device_rename", { deviceId, name });
}
