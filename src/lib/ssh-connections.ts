import { invoke } from "@tauri-apps/api/core";

import type { Connection } from "@/lib/pi-runtime";
import type { ConnectionTestResult } from "@/lib/connections";

export type SshConnectionInfo = {
	connection: Connection;
	workspaceCount: number;
	hasPassword: boolean;
};

export function listSshConnections(): Promise<SshConnectionInfo[]> {
	return invoke<SshConnectionInfo[]>("ssh_connection_list");
}

export function saveSshConnection(
	connection: Connection,
	password?: string,
): Promise<SshConnectionInfo> {
	return invoke<SshConnectionInfo>("ssh_connection_save", {
		request: { connection, password: password || null },
	});
}

export function removeSshConnection(id: string): Promise<void> {
	return invoke("ssh_connection_remove", { id });
}

export function testSshConnection(id: string): Promise<ConnectionTestResult> {
	return invoke<ConnectionTestResult>("ssh_connection_test", { id });
}
