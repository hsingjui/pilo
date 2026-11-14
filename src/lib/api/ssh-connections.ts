import { invoke } from "@tauri-apps/api/core";

import { notifyConnectionsChanged } from "@/lib/api/connection-events";
import type { Connection } from "@/lib/api/pi-runtime";
import type { ConnectionTestResult } from "@/lib/api/connections";
import { notifyProjectsChanged } from "@/lib/api/projects";

export type SshConnectionInfo = {
	connection: Connection;
	projectCount: number;
	hasPassword: boolean;
	localPiResources?: boolean;
};

export type SshAgentIdentity = {
	publicKey: string;
	fingerprint: string;
	comment: string;
};

export function listSshAgentIdentities(): Promise<SshAgentIdentity[]> {
	return invoke<SshAgentIdentity[]>("ssh_agent_identities_list");
}

export function listSshConnections(): Promise<SshConnectionInfo[]> {
	return invoke<SshConnectionInfo[]>("ssh_connection_list");
}

export async function saveSshConnection(
	connection: Connection,
	password?: string,
	localPiResources?: boolean,
): Promise<SshConnectionInfo> {
	const info = await invoke<SshConnectionInfo>("ssh_connection_save", {
		request: { connection, password: password || null, localPiResources },
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

export function getSshConnectionPassword(id: string): Promise<string | null> {
	return invoke<string | null>("ssh_connection_password_get", { id });
}

export function testSshConnectionDraft(
	connection: Connection,
	password?: string,
): Promise<ConnectionTestResult> {
	return invoke<ConnectionTestResult>("ssh_connection_test_draft", {
		connection,
		password: password || null,
	});
}
