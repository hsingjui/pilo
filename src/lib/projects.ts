import { invoke } from "@tauri-apps/api/core";

import type { FsEntry } from "@/lib/files";
import type { Connection, PiSessionSnapshot } from "@/lib/pi-runtime";

export const PROJECTS_CHANGED_EVENT = "pilo:projects-changed";

export type ProjectMetadata = {
	cwd: string;
	gitBranch: string | null;
	piVersion: string;
	refreshedAtMs: number;
};

export type Project = {
	id: string;
	name: string;
	path: string;
	connection: Connection;
	metadata: ProjectMetadata;
	createdAtMs: number;
	lastOpenedAtMs: number;
};

export type DiscoveredProject = {
	name: string;
	path: string;
	alreadyAdded: boolean;
};

export function localConnection(): Connection {
	return { id: "local", name: "本地", kind: { type: "local" } };
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

export function listProjects(): Promise<Project[]> {
	return invoke<Project[]>("project_list");
}

export function addProject(
	connectionId: string,
	path: string,
): Promise<Project> {
	return invoke<Project>("project_add", { connectionId, path });
}

export function pickLocalProjectDirectory(): Promise<string | null> {
	return invoke<string | null>("local_pick_project_directory");
}

export function readConnectionDir(
	connectionId: string,
	path = "/",
): Promise<FsEntry[]> {
	return invoke<FsEntry[]>("connection_fs_read_dir", { connectionId, path });
}

export function refreshProject(id: string): Promise<Project> {
	return invoke<Project>("project_refresh", { id });
}

export function touchProject(id: string): Promise<Project> {
	return invoke<Project>("project_touch", { id });
}

export function reorderProjects(
	connectionId: string,
	projectIds: string[],
): Promise<Project[]> {
	return invoke<Project[]>("project_reorder", { connectionId, projectIds });
}

export function removeProject(id: string): Promise<Project[]> {
	return invoke<Project[]>("project_remove", { id });
}

export function discoverProjects(
	connectionId: string,
): Promise<DiscoveredProject[]> {
	return invoke<DiscoveredProject[]>("project_discover", { connectionId });
}

const pendingPiStarts = new Map<string, Promise<PiSessionSnapshot>>();

export function ensureProjectPi(
	project: Pick<Project, "id">,
): Promise<PiSessionSnapshot> {
	const pending = pendingPiStarts.get(project.id);
	if (pending) return pending;
	const request = startProjectPi(project.id).finally(() => {
		pendingPiStarts.delete(project.id);
	});
	pendingPiStarts.set(project.id, request);
	return request;
}

async function startProjectPi(id: string): Promise<PiSessionSnapshot> {
	const current = await invoke<PiSessionSnapshot>("runtime_get_pi_state");
	if (current.state === "running" && current.projectId === id) {
		return current;
	}
	if (current.state === "starting" || current.state === "stopping") {
		throw new Error(`Pi Runtime 当前处于 ${current.state} 状态，请稍后重试。`);
	}
	if (current.state === "running") {
		await invoke("runtime_stop_pi");
	}
	return invoke<PiSessionSnapshot>("project_start_pi", { id });
}

export function notifyProjectsChanged() {
	window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
}

export function connectionLabel(connection: Connection): string {
	return connection.name;
}
