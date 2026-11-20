import { invoke } from "@tauri-apps/api/core";

import type { RemoteAccessAddress, RemoteHostState } from "./remote-types";

export type {
	RemoteAccessAddress,
	RemoteDevice,
	RemoteHostState,
} from "./remote-types";

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
