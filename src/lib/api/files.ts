import { invoke } from "@tauri-apps/api/core";
import { i18n } from "../../i18n/index.ts";
import { registerChatFile } from "@/lib/chat/chat-file-lifecycle";

export type { FsEntry, FsEntryKind } from "./files-types";
import type { FsEntry } from "./files-types";

export function readProjectDir(
	projectId: string,
	path = "",
): Promise<FsEntry[]> {
	return invoke("project_fs_read_dir", { id: projectId, path });
}

/** Read-only viewer access: project-relative or absolute on the project connection. */
export function readProjectFile(
	projectId: string,
	path: string,
): Promise<Uint8Array> {
	return invoke<number[]>("project_fs_read_file", {
		id: projectId,
		path,
	}).then((data) => new Uint8Array(data));
}

/** Text-only projection used by the existing project-contained viewer. */
export async function readProjectTextFile(
	projectId: string,
	path: string,
): Promise<string> {
	const data = await readProjectFile(projectId, path);
	if (data.byteLength > 5 * 1024 * 1024)
		throw new Error(i18n.t("file.tooLarge", { size: 5 }));
	if (data.subarray(0, Math.min(data.length, 8192)).includes(0))
		throw new Error(i18n.t("file.binary"));
	return new TextDecoder("utf-8", { fatal: true }).decode(data);
}

/** Image-only, project-contained read for assistant Markdown replies. */
export function readProjectImage(
	projectId: string,
	path: string,
): Promise<Uint8Array<ArrayBuffer>> {
	return invoke<number[]>("project_fs_read_image", {
		id: projectId,
		path,
	}).then((data) => new Uint8Array(data));
}

export async function uploadChatFile(
	projectId: string,
	file: File,
): Promise<string> {
	const path = await invoke<string>("project_chat_file_upload", {
		id: projectId,
		name: file.name,
		data: Array.from(new Uint8Array(await file.arrayBuffer())),
	});
	return registerChatFile(path, () =>
		invoke<void>("project_chat_file_remove", { id: projectId, path }),
	);
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
