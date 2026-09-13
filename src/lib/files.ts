import { invoke } from "@tauri-apps/api/core";

export type FsEntryKind = "file" | "directory" | "symlink" | "other";

export type FsEntry = {
	path: string;
	name: string;
	kind: FsEntryKind;
	size: number;
	modifiedAtMs?: number;
};

export function readProjectDir(
	projectId: string,
	path = "",
): Promise<FsEntry[]> {
	return invoke("project_fs_read_dir", { id: projectId, path });
}

export function readProjectFile(
	projectId: string,
	path: string,
): Promise<Uint8Array> {
	return invoke<number[]>("project_fs_read_file", {
		id: projectId,
		path,
	}).then((data) => new Uint8Array(data));
}

export function writeProjectFile(
	projectId: string,
	path: string,
	data: Uint8Array,
): Promise<void> {
	return invoke("project_fs_write_file", {
		id: projectId,
		path,
		data: Array.from(data),
	});
}

export function statProjectPath(
	projectId: string,
	path = "",
): Promise<FsEntry> {
	return invoke("project_fs_stat", { id: projectId, path });
}

export function createProjectDir(
	projectId: string,
	path: string,
): Promise<void> {
	return invoke("project_fs_mkdir", { id: projectId, path });
}

export function renameProjectPath(
	projectId: string,
	from: string,
	to: string,
): Promise<void> {
	return invoke("project_fs_rename", { id: projectId, from, to });
}

export function removeProjectPath(
	projectId: string,
	path: string,
): Promise<void> {
	return invoke("project_fs_remove", { id: projectId, path });
}

export function searchProjectFiles(
	projectId: string,
	query: string,
): Promise<string[]> {
	return invoke("project_fs_search", { id: projectId, query });
}
