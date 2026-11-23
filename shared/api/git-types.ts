export type GitFileStatus = {
	path: string;
	originalPath?: string | null;
	indexStatus: string;
	worktreeStatus: string;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
	stagedAdditions?: number | null;
	stagedDeletions?: number | null;
	unstagedAdditions?: number | null;
	unstagedDeletions?: number | null;
};

export type GitStatus = {
	branch?: string | null;
	files: GitFileStatus[];
};
