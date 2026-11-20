import type { Connection } from "./pi-runtime-types";

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

/** Built-in project IDs are stable across hiding, renaming and restarts. */
export function isDefaultWorkspace(project: { id: string }): boolean {
	return project.id.startsWith("default-workspace:");
}
