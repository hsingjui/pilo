import { invoke } from "@tauri-apps/api/core";

import { notifyConnectionsChanged } from "@/lib/connection-events";
import type { Connection } from "@/lib/pi-runtime";
import { localConnection, notifyProjectsChanged } from "@/lib/projects";
import { listSshConnections } from "@/lib/ssh-connections";

export type ConnectionTestResult = {
	protocolVersion: number;
	serverVersion: string;
};

export type PiExecutableInfo = {
	executable: string;
	version: string;
};

export type WslConnectionInfo = {
	connection: Connection;
	projectCount: number;
};

export type WslDistribution = {
	name: string;
};

export function listWslConnections(): Promise<WslConnectionInfo[]> {
	return invoke<WslConnectionInfo[]>("wsl_connection_list");
}

export function listWslDistributions(): Promise<WslDistribution[]> {
	return invoke<WslDistribution[]>("wsl_list_distributions");
}

export async function saveWslConnection(
	connection: Connection,
): Promise<WslConnectionInfo> {
	const info = await invoke<WslConnectionInfo>("wsl_connection_save", {
		connection,
	});
	notifyConnectionsChanged();
	return info;
}

export async function removeWslConnection(id: string): Promise<void> {
	await invoke("wsl_connection_remove", { id });
	notifyConnectionsChanged();
	notifyProjectsChanged();
}

export function testWslConnection(
	distro: string,
): Promise<ConnectionTestResult> {
	return invoke<ConnectionTestResult>("wsl_connection_test", { distro });
}

export function testLocalConnection(): Promise<ConnectionTestResult> {
	return invoke<ConnectionTestResult>("local_connection_test");
}

export function getLocalConnection(): Promise<Connection> {
	return invoke<Connection>("local_connection_get");
}

export async function updateConnectionSettings(
	id: string,
	name: string,
	piExecutable: string | null,
): Promise<Connection> {
	const connection = await invoke<Connection>("connection_settings_update", {
		id,
		name,
		piExecutable,
	});
	notifyConnectionsChanged();
	notifyProjectsChanged();
	return connection;
}

export function probeConnectionPi(
	id: string,
	executable?: string | null,
): Promise<PiExecutableInfo> {
	return invoke<PiExecutableInfo>("connection_pi_probe", {
		id,
		executable: executable?.trim() || null,
	});
}

/** 本机 + 已添加的 WSL/SSH 连接，用于首页环境列表和连接页统一展示。 */
export async function listConnectionCatalog(): Promise<Connection[]> {
	const [local, wsl, ssh] = await Promise.allSettled([
		getLocalConnection(),
		listWslConnections(),
		listSshConnections(),
	]);
	const connections: Connection[] = [
		local.status === "fulfilled" ? local.value : localConnection(),
	];
	if (wsl.status === "fulfilled") {
		connections.push(...wsl.value.map((info) => info.connection));
	}
	if (ssh.status === "fulfilled") {
		connections.push(...ssh.value.map((info) => info.connection));
	}
	return connections;
}
