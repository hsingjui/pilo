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

export type RemoteHostState = {
	enabled: boolean;
	running: boolean;
	port: number;
	baseUrl: string | null;
	publicBaseUrl: string;
	pairingUrl: string | null;
	pairingExpiresAtMs: number | null;
	lastError: string | null;
	devices: RemoteDevice[];
};

export function getRemoteHostState(): Promise<RemoteHostState> {
	return invoke<RemoteHostState>("remote_host_state");
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
