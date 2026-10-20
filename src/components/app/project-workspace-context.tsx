import {
	createContext,
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
} from "react";

import {
	reduceProjectWorkspaces,
	type GitWorkspaceView,
	type WorkspaceFile,
} from "@/lib/project-workspace";

export function useProjectWorkspaces(projectIds: readonly string[]) {
	const [state, dispatch] = useReducer(reduceProjectWorkspaces, new Map());
	const availableProjects = useRef(projectIds);
	useEffect(() => {
		availableProjects.current = projectIds;
		dispatch({ type: "prune", projectIds });
	}, [projectIds]);
	const openFile = useCallback((projectId: string, file: WorkspaceFile) => {
		// Ignore a pending read that finishes after its project was removed.
		if (!availableProjects.current.includes(projectId)) return;
		dispatch({ type: "open", projectId, file });
	}, []);
	const selectFile = useCallback((projectId: string, path: string | null) => {
		dispatch({ type: "select", projectId, path });
	}, []);
	const closeFile = useCallback((projectId: string, path: string) => {
		dispatch({ type: "close", projectId, path });
	}, []);
	const openGit = useCallback((projectId: string) => {
		if (!availableProjects.current.includes(projectId)) return;
		dispatch({ type: "open-git", projectId });
	}, []);
	const closeGit = useCallback((projectId: string) => {
		dispatch({ type: "close-git", projectId });
	}, []);
	const updateGitView = useCallback(
		(projectId: string, view: Partial<GitWorkspaceView>) => {
			dispatch({ type: "update-git-view", projectId, view });
		},
		[],
	);
	const highlightFile = useCallback(
		(projectId: string, file: WorkspaceFile, html: string | null) => {
			dispatch({ type: "highlight", projectId, file, html });
		},
		[],
	);
	return useMemo(
		() => ({
			state,
			openFile,
			selectFile,
			closeFile,
			openGit,
			closeGit,
			updateGitView,
			highlightFile,
		}),
		[
			state,
			openFile,
			selectFile,
			closeFile,
			openGit,
			closeGit,
			updateGitView,
			highlightFile,
		],
	);
}

export const ProjectWorkspaceContext = createContext<ReturnType<
	typeof useProjectWorkspaces
> | null>(null);
