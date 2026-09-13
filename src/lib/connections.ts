import { invoke } from "@tauri-apps/api/core";

import type { Connection } from "@/lib/pi-runtime";

export type ConnectionTestResult = {
	protocolVersion: number;
	serverVersion: string;
};

export type WslConnectionInfo = {
	connection: Connection;
	workspaceCount: number;
};

export function listWslConnections(): Promise<WslConnectionInfo[]> {
	return invoke<WslConnectionInfo[]>("wsl_connection_list");
}

export function testWslConnection(
	distro: string,
): Promise<ConnectionTestResult> {
	return invoke<ConnectionTestResult>("wsl_connection_test", { distro });
}

export function testLocalConnection(): Promise<ConnectionTestResult> {
	return invoke<ConnectionTestResult>("local_connection_test");
}
