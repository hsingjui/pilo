import { invoke } from "@tauri-apps/api/core";

import type { Connection, PiSessionSnapshot } from "@/lib/pi-runtime";

export const WORKSPACES_CHANGED_EVENT = "pilo:workspaces-changed";

export type WorkspaceMetadata = {
	cwd: string;
	gitBranch: string | null;
	piVersion: string;
	refreshedAtMs: number;
};

export type Workspace = {
	id: string;
	name: string;
	path: string;
	connection: Connection;
	metadata: WorkspaceMetadata;
	createdAtMs: number;
	lastOpenedAtMs: number;
};

export type DiscoveredWorkspace = {
	name: string;
	path: string;
	alreadyAdded: boolean;
};

export function localConnection(): Connection {
	return { id: "local", name: "Local", kind: { type: "local" } };
}

export function wslConnection(distro: string): Connection {
	return {
		id: `wsl:${distro}`,
		name: `WSL · ${distro}`,
		kind: { type: "wsl", distro },
	};
}

export function sshConfigConnection(host: string): Connection {
	return {
		id: `ssh:config:${host}`,
		name: `SSH · ${host}`,
		kind: {
			type: "ssh",
			target: { type: "config_host", host, authMethod: "agent" },
		},
	};
}

export function listWorkspaces(): Promise<Workspace[]> {
	return invoke<Workspace[]>("workspace_list");
}

export function addWorkspace(
	connection: Connection,
	path: string,
): Promise<Workspace> {
	return invoke<Workspace>("workspace_add", { connection, path });
}

export function refreshWorkspace(id: string): Promise<Workspace> {
	return invoke<Workspace>("workspace_refresh", { id });
}

export function touchWorkspace(id: string): Promise<Workspace> {
	return invoke<Workspace>("workspace_touch", { id });
}

export function removeWorkspace(id: string): Promise<Workspace[]> {
	return invoke<Workspace[]>("workspace_remove", { id });
}

export function discoverWorkspaces(
	connection: Connection,
): Promise<DiscoveredWorkspace[]> {
	return invoke<DiscoveredWorkspace[]>("workspace_discover", { connection });
}

const pendingPiStarts = new Map<string, Promise<PiSessionSnapshot>>();

export function ensureWorkspacePi(
	workspace: Pick<Workspace, "id">,
): Promise<PiSessionSnapshot> {
	const pending = pendingPiStarts.get(workspace.id);
	if (pending) return pending;
	const request = startWorkspacePi(workspace.id).finally(() => {
		pendingPiStarts.delete(workspace.id);
	});
	pendingPiStarts.set(workspace.id, request);
	return request;
}

async function startWorkspacePi(id: string): Promise<PiSessionSnapshot> {
	const current = await invoke<PiSessionSnapshot>("runtime_get_pi_state");
	if (current.state === "running" && current.workspaceId === id) {
		return current;
	}
	if (current.state === "starting" || current.state === "stopping") {
		throw new Error(`Pi Runtime 当前处于 ${current.state} 状态，请稍后重试。`);
	}
	if (current.state === "running") {
		await invoke("runtime_stop_pi");
	}
	return invoke<PiSessionSnapshot>("workspace_start_pi", { id });
}

export function notifyWorkspacesChanged() {
	window.dispatchEvent(new Event(WORKSPACES_CHANGED_EVENT));
}

export function connectionLabel(connection: Connection): string {
	switch (connection.kind.type) {
		case "local":
			return "本地";
		case "wsl":
			return `WSL · ${connection.kind.distro}`;
		case "ssh":
			return connection.name;
	}
}
