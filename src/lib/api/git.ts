import { invoke } from "@tauri-apps/api/core";

export type GitFileStatus = {
	path: string;
	originalPath?: string | null;
	indexStatus: string;
	worktreeStatus: string;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
};

export type GitStatus = {
	branch?: string | null;
	files: GitFileStatus[];
};

export function getProjectGitStatus(projectId: string): Promise<GitStatus> {
	return invoke<GitStatus>("project_git_status", { id: projectId });
}

export function getProjectGitDiff(
	projectId: string,
	options: { path?: string; staged: boolean },
): Promise<string> {
	return invoke<string>("project_git_diff", {
		id: projectId,
		path: options.path ?? null,
		staged: options.staged,
	});
}
