export type WorkspaceFile = {
	path: string;
	content: string;
	html?: string | null;
};

export type WorkspaceTab =
	| { kind: "chat" }
	| { kind: "file"; path: string }
	| { kind: "git" };

export type GitWorkspaceView = {
	mode: "working" | "staged";
	selectedPath: string | null;
	showDetail: boolean;
	listWidth?: number;
	diffStyle: "unified" | "split";
	wrapLines: boolean;
};

export const DEFAULT_GIT_WORKSPACE_VIEW: GitWorkspaceView = {
	mode: "working",
	selectedPath: null,
	showDetail: false,
	diffStyle: "split",
	wrapLines: false,
};

export type ProjectWorkspace = {
	files: readonly WorkspaceFile[];
	gitOpen: boolean;
	gitView?: GitWorkspaceView;
	activeTab: WorkspaceTab;
};

export const EMPTY_PROJECT_WORKSPACE: ProjectWorkspace = {
	files: [],
	gitOpen: false,
	activeTab: { kind: "chat" },
};

export function workspaceFileKey(path: string): string {
	// Windows canonicalize returns a verbatim drive path (\\\\?\\C:\\...), while links/sidebar use C:/....
	const normalized = path
		.replace(/\\/g, "/")
		.replace(/^\/\/\?\/([a-z]:\/)/i, "$1");
	return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

type WorkspaceAction =
	| { type: "open"; projectId: string; file: WorkspaceFile }
	| { type: "select"; projectId: string; path: string | null }
	| { type: "close"; projectId: string; path: string }
	| { type: "open-git"; projectId: string }
	| { type: "close-git"; projectId: string }
	| {
			type: "update-git-view";
			projectId: string;
			view: Partial<GitWorkspaceView>;
	  }
	| {
			type: "highlight";
			projectId: string;
			file: WorkspaceFile;
			html: string | null;
	  }
	| { type: "prune"; projectIds: readonly string[] };

export function reduceProjectWorkspaces(
	state: ReadonlyMap<string, ProjectWorkspace>,
	action: WorkspaceAction,
): ReadonlyMap<string, ProjectWorkspace> {
	if (action.type === "prune") {
		const valid = new Set(action.projectIds);
		if (Array.from(state.keys()).every((id) => valid.has(id))) return state;
		return new Map(Array.from(state).filter(([id]) => valid.has(id)));
	}
	const current = state.get(action.projectId) ?? EMPTY_PROJECT_WORKSPACE;
	let next: ProjectWorkspace;
	switch (action.type) {
		case "open": {
			const key = workspaceFileKey(action.file.path);
			const existing = current.files.find(
				(file) => workspaceFileKey(file.path) === key,
			);
			next = {
				...current,
				files: existing ? current.files : [...current.files, action.file],
				activeTab: { kind: "file", path: existing?.path ?? action.file.path },
			};
			break;
		}
		case "select": {
			if (
				action.path !== null &&
				!current.files.some((file) => file.path === action.path)
			)
				return state;
			if (
				(action.path === null && current.activeTab.kind === "chat") ||
				(current.activeTab.kind === "file" &&
					current.activeTab.path === action.path)
			)
				return state;
			next = {
				...current,
				activeTab:
					action.path === null
						? { kind: "chat" }
						: { kind: "file", path: action.path },
			};
			break;
		}
		case "close": {
			const index = current.files.findIndex(
				(file) => file.path === action.path,
			);
			if (index < 0) return state;
			const files = current.files.filter((file) => file.path !== action.path);
			const neighbor = files[Math.min(index, files.length - 1)];
			next = {
				...current,
				files,
				activeTab:
					current.activeTab.kind === "file" &&
					current.activeTab.path === action.path
						? neighbor
							? { kind: "file", path: neighbor.path }
							: { kind: current.gitOpen ? "git" : "chat" }
						: current.activeTab,
			};
			break;
		}
		case "open-git": {
			if (current.gitOpen && current.activeTab.kind === "git") return state;
			next = { ...current, gitOpen: true, activeTab: { kind: "git" } };
			break;
		}
		case "close-git": {
			if (!current.gitOpen) return state;
			const neighbor = current.files[0];
			next = {
				...current,
				gitOpen: false,
				activeTab:
					current.activeTab.kind === "git"
						? neighbor
							? { kind: "file", path: neighbor.path }
							: { kind: "chat" }
						: current.activeTab,
			};
			break;
		}
		case "update-git-view": {
			if (!current.gitOpen) return state;
			next = {
				...current,
				gitView: {
					...(current.gitView ?? DEFAULT_GIT_WORKSPACE_VIEW),
					...action.view,
				},
			};
			break;
		}
		case "highlight": {
			if (!current.files.includes(action.file)) return state;
			next = {
				...current,
				files: current.files.map((file) =>
					file === action.file
						? Object.assign({}, file, { html: action.html })
						: file,
				),
			};
			break;
		}
	}
	return new Map(state).set(action.projectId, next);
}
