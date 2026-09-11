import { invoke } from "@tauri-apps/api/core";

export type GitFileStatus = {
	path: string;
	originalPath?: string;
	indexStatus: string;
	worktreeStatus: string;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
};

export type GitStatus = {
	branch?: string;
	files: GitFileStatus[];
};

export function getWorkspaceGitStatus(workspaceId: string): Promise<GitStatus> {
	return invoke("workspace_git_status", { id: workspaceId });
}

export function getWorkspaceGitDiff(
	workspaceId: string,
	options: { path?: string; staged: boolean },
): Promise<string> {
	return invoke("workspace_git_diff", {
		id: workspaceId,
		path: options.path ?? null,
		staged: options.staged,
	});
}
