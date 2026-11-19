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
