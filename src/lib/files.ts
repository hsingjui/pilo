import { invoke } from "@tauri-apps/api/core";

export type FsEntryKind = "file" | "directory" | "symlink" | "other";

export type FsEntry = {
	path: string;
	name: string;
	kind: FsEntryKind;
	size: number;
	modifiedAtMs?: number;
};

export function readWorkspaceDir(
	workspaceId: string,
	path = "",
): Promise<FsEntry[]> {
	return invoke("workspace_fs_read_dir", { id: workspaceId, path });
}

export function readWorkspaceFile(
	workspaceId: string,
	path: string,
): Promise<Uint8Array> {
	return invoke<number[]>("workspace_fs_read_file", {
		id: workspaceId,
		path,
	}).then((data) => new Uint8Array(data));
}

export function writeWorkspaceFile(
	workspaceId: string,
	path: string,
	data: Uint8Array,
): Promise<void> {
	return invoke("workspace_fs_write_file", {
		id: workspaceId,
		path,
		data: Array.from(data),
	});
}

export function statWorkspacePath(
	workspaceId: string,
	path = "",
): Promise<FsEntry> {
	return invoke("workspace_fs_stat", { id: workspaceId, path });
}

export function createWorkspaceDir(
	workspaceId: string,
	path: string,
): Promise<void> {
	return invoke("workspace_fs_mkdir", { id: workspaceId, path });
}

export function renameWorkspacePath(
	workspaceId: string,
	from: string,
	to: string,
): Promise<void> {
	return invoke("workspace_fs_rename", { id: workspaceId, from, to });
}

export function removeWorkspacePath(
	workspaceId: string,
	path: string,
): Promise<void> {
	return invoke("workspace_fs_remove", { id: workspaceId, path });
}

export function searchWorkspaceFiles(
	workspaceId: string,
	query: string,
): Promise<string[]> {
	return invoke("workspace_fs_search", { id: workspaceId, query });
}
