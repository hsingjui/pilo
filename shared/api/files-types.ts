export type FsEntryKind = "file" | "directory" | "symlink" | "other";

export type FsEntry = {
	path: string;
	name: string;
	kind: FsEntryKind;
	size: number;
	modifiedAtMs?: number;
};
