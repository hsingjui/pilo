import { invoke } from "@tauri-apps/api/core";

import { notifyConnectionsChanged } from "@/lib/connection-events";
import type { Connection } from "@/lib/pi-runtime";
import type { ConnectionTestResult } from "@/lib/connections";
import { notifyProjectsChanged } from "@/lib/projects";

export type SshConnectionInfo = {
	connection: Connection;
	projectCount: number;
	hasPassword: boolean;
};

export function listSshConnections(): Promise<SshConnectionInfo[]> {
	return invoke<SshConnectionInfo[]>("ssh_connection_list");
}

export async function saveSshConnection(
	connection: Connection,
	password?: string,
): Promise<SshConnectionInfo> {
	const info = await invoke<SshConnectionInfo>("ssh_connection_save", {
		request: { connection, password: password || null },
	});
	notifyConnectionsChanged();
	return info;
}

export async function removeSshConnection(id: string): Promise<void> {
	await invoke("ssh_connection_remove", { id });
	notifyConnectionsChanged();
	notifyProjectsChanged();
}

export function testSshConnection(id: string): Promise<ConnectionTestResult> {
	return invoke<ConnectionTestResult>("ssh_connection_test", { id });
}
