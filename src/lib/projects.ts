import { invoke } from "@tauri-apps/api/core";

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

export function listProjects(): Promise<Project[]> {
	return invoke<Project[]>("project_list");
}

export function addProject(
	connection: Connection,
	path: string,
): Promise<Project> {
	return invoke<Project>("project_add", { connection, path });
}

export function refreshProject(id: string): Promise<Project> {
	return invoke<Project>("project_refresh", { id });
}

export function touchProject(id: string): Promise<Project> {
	return invoke<Project>("project_touch", { id });
}

export function removeProject(id: string): Promise<Project[]> {
	return invoke<Project[]>("project_remove", { id });
}

export function discoverProjects(
	connection: Connection,
): Promise<DiscoveredProject[]> {
	return invoke<DiscoveredProject[]>("project_discover", { connection });
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
	switch (connection.kind.type) {
		case "local":
			return "本地";
		case "wsl":
			return `WSL · ${connection.kind.distro}`;
		case "ssh":
			return connection.name;
	}
}
