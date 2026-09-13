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

export function getProjectGitStatus(projectId: string): Promise<GitStatus> {
	return invoke("project_git_status", { id: projectId });
}

export function getProjectGitDiff(
	projectId: string,
	options: { path?: string; staged: boolean },
): Promise<string> {
	return invoke("project_git_diff", {
		id: projectId,
		path: options.path ?? null,
		staged: options.staged,
	});
}
