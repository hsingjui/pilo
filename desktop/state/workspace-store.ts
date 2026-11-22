import { type Accessor, signal } from "nsh";

import {
	EMPTY_PROJECT_WORKSPACE,
	reduceProjectWorkspaces,
	workspaceFileKey,
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
		this.workspacesSignal.update((state) =>
			reduceProjectWorkspaces(state, {
				type: "open",
				projectId,
				file,
				lineRange,
			}),
		);
		this.navigationTokenSignal.update((value) => value + 1);
	}

	selectFile(
		projectId: string,
		path: string | null,
		lineRange?: WorkspaceLineRange,
	): void {
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

	reconcileProjects(projectIds: readonly string[]): void {
		this.workspacesSignal.update((state) =>
			reduceProjectWorkspaces(state, { type: "prune", projectIds }),
		);
	}
}
