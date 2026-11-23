import { type Accessor, batch, signal } from "nsh";

import {
	DEFAULT_GIT_WORKSPACE_VIEW,
	EMPTY_PROJECT_WORKSPACE,
	reduceProjectWorkspaces,
	workspaceFileKey,
	type GitWorkspaceView,
	type ProjectWorkspace,
	type WorkspaceFile,
	type WorkspaceLineRange,
} from "@shared/project-workspace";

export interface ActiveWorkspaceFile {
	projectId: string;
	file: WorkspaceFile;
	lineRange?: WorkspaceLineRange;
	navigationToken: number;
}

export interface OpenWorkspaceFileEntry {
	projectId: string;
	file: WorkspaceFile;
}

/**
 * Per-project file preview tabs built on `shared/project-workspace`.
 * Keeps open files isolated per project so switching tabs or projects
 * never leaks state across projects.
 */
export class WorkspaceStore {
	private readonly workspacesSignal = signal<
		ReadonlyMap<string, ProjectWorkspace>
	>(new Map());
	private readonly navigationTokenSignal = signal(0);

	readonly workspaces: Accessor<ReadonlyMap<string, ProjectWorkspace>> =
		this.workspacesSignal;

	projectWorkspace(projectId: string | null | undefined): ProjectWorkspace {
		if (!projectId) return EMPTY_PROJECT_WORKSPACE;
		return this.workspacesSignal().get(projectId) ?? EMPTY_PROJECT_WORKSPACE;
	}

	files(projectId: string | null | undefined): readonly WorkspaceFile[] {
		return this.projectWorkspace(projectId).files;
	}

	findFile(projectId: string, path: string): WorkspaceFile | undefined {
		const targetKey = workspaceFileKey(path);
		return this.files(projectId).find(
			(file) => workspaceFileKey(file.path) === targetKey,
		);
	}

	activeFile(projectId: string | null | undefined): ActiveWorkspaceFile | null {
		if (!projectId) return null;
		const workspace = this.projectWorkspace(projectId);
		if (workspace.activeTab.kind !== "file") return null;
		const { path, lineRange } = workspace.activeTab;
		const file = workspace.files.find((entry) => entry.path === path);
		if (!file) return null;
		return {
			projectId,
			file,
			lineRange,
			navigationToken: this.navigationTokenSignal(),
		};
	}

	allOpenFiles(): OpenWorkspaceFileEntry[] {
		const entries: OpenWorkspaceFileEntry[] = [];
		for (const [projectId, workspace] of this.workspacesSignal()) {
			for (const file of workspace.files) {
				entries.push({ projectId, file });
			}
		}
		return entries;
	}

	openFile(
		projectId: string,
		file: WorkspaceFile,
		lineRange?: WorkspaceLineRange,
	): void {
		batch(() => {
			this.workspacesSignal.update((state) =>
				reduceProjectWorkspaces(state, {
					type: "open",
					projectId,
					file,
					lineRange,
				}),
			);
			this.navigationTokenSignal.update((value) => value + 1);
		});
	}

	selectFile(
		projectId: string,
		path: string | null,
		lineRange?: WorkspaceLineRange,
	): void {
		batch(() => {
			this.workspacesSignal.update((state) =>
				reduceProjectWorkspaces(state, {
					type: "select",
					projectId,
					path,
					lineRange,
				}),
			);
			if (path !== null && lineRange) {
				this.navigationTokenSignal.update((value) => value + 1);
			}
		});
	}

	selectChat(projectId: string | null | undefined): void {
		if (!projectId) return;
		this.selectFile(projectId, null);
	}

	closeFile(projectId: string, path: string): void {
		this.workspacesSignal.update((state) =>
			reduceProjectWorkspaces(state, { type: "close", projectId, path }),
		);
	}

	isGitOpen(projectId: string | null | undefined): boolean {
		return this.projectWorkspace(projectId).gitOpen;
	}

	isGitActive(projectId: string | null | undefined): boolean {
		if (!projectId) return false;
		const workspace = this.projectWorkspace(projectId);
		return workspace.gitOpen && workspace.activeTab.kind === "git";
	}

	gitView(projectId: string | null | undefined): GitWorkspaceView {
		return (
			this.projectWorkspace(projectId).gitView ?? DEFAULT_GIT_WORKSPACE_VIEW
		);
	}

	openGitProjectIds(): string[] {
		const ids: string[] = [];
		for (const [projectId, workspace] of this.workspacesSignal()) {
			if (workspace.gitOpen) ids.push(projectId);
		}
		return ids;
	}

	openGit(projectId: string): void {
		this.workspacesSignal.update((state) => {
			const wasOpen = state.get(projectId)?.gitOpen ?? false;
			const opened = reduceProjectWorkspaces(state, {
				type: "open-git",
				projectId,
			});
			if (wasOpen) return opened;
			return reduceProjectWorkspaces(opened, {
				type: "update-git-view",
				projectId,
				view: { showDetail: false },
			});
		});
	}

	closeGit(projectId: string): void {
		this.workspacesSignal.update((state) =>
			reduceProjectWorkspaces(state, { type: "close-git", projectId }),
		);
	}

	updateGitView(projectId: string, view: Partial<GitWorkspaceView>): void {
		this.workspacesSignal.update((state) =>
			reduceProjectWorkspaces(state, {
				type: "update-git-view",
				projectId,
				view,
			}),
		);
	}

	reconcileProjects(projectIds: readonly string[]): void {
		this.workspacesSignal.update((state) =>
			reduceProjectWorkspaces(state, { type: "prune", projectIds }),
		);
	}
}
