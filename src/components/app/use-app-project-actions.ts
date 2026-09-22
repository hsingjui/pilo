import {
	useCallback,
	useRef,
	useState,
	type Dispatch,
	type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { userErrorMessage } from "@/lib/app-error";
import { removeWslConnection } from "@/lib/connections";
import { setConnectionShownInHome } from "@/lib/home-connections";
import { refreshProjectPiModels } from "@/lib/pi-models";
import type { Connection } from "@/lib/pi-runtime";
import {
	addProject,
	connectionLabel,
	listProjects,
	notifyProjectsChanged,
	pickLocalProjectDirectory,
	removeProject,
	reorderProjects,
	type Project,
} from "@/lib/projects";
import { removeSshConnection } from "@/lib/ssh-connections";

type UseAppProjectActionsOptions = {
	projects: Project[];
	setProjects: Dispatch<SetStateAction<Project[]>>;
	connectionCatalog: Connection[];
	onProjectsRemoved: (
		projectIds: ReadonlySet<string>,
		nextProjects: Project[],
	) => void;
};

export function useAppProjectActions({
	projects,
	setProjects,
	connectionCatalog,
	onProjectsRemoved,
}: UseAppProjectActionsOptions) {
	const { t } = useTranslation();
	const [addProjectOpen, setAddProjectOpen] = useState(false);
	const [addProjectConnectionId, setAddProjectConnectionId] = useState<
		string | null
	>(null);
	const localProjectPickerPendingRef = useRef(false);

	const handleAddProject = useCallback(
		async (connectionId?: string) => {
			const connection =
				connectionCatalog.find((item) => item.id === connectionId) ??
				projects.find((project) => project.connection.id === connectionId)
					?.connection ??
				null;
			if (!connection) return;

			if (connection.kind.type !== "local") {
				setAddProjectConnectionId(connection.id);
				setAddProjectOpen(true);
				return;
			}

			if (localProjectPickerPendingRef.current) return;
			localProjectPickerPendingRef.current = true;
			try {
				const selectedPath = await pickLocalProjectDirectory();
				if (!selectedPath) return;
				const project = await addProject(connection.id, selectedPath);
				void refreshProjectPiModels(project.id).catch((error) => {
					console.warn(
						"Failed to refresh Pi models after adding project",
						error,
					);
				});
				notifyProjectsChanged();
				toast.success(t("project.added", { name: project.name }), {
					description: t("project.addedDescription", {
						connection: connectionLabel(project.connection),
						path: project.metadata.cwd,
					}),
				});
			} catch (error) {
				toast.error(t("project.addFailed"), {
					description: userErrorMessage(error),
				});
			} finally {
				localProjectPickerPendingRef.current = false;
			}
		},
		[connectionCatalog, projects, t],
	);

	const handleReorderProjects = useCallback(
		async (connectionId: string, projectIds: string[]) => {
			const previous = projects;
			const rank = new Map(projectIds.map((id, index) => [id, index]));
			setProjects((current) => {
				const reordered = current.filter(
					(project) => project.connection.id === connectionId,
				);
				reordered.sort(
					(a, b) =>
						(rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
						(rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
				);
				let index = 0;
				return current.map((project) =>
					project.connection.id === connectionId
						? (reordered[index++] ?? project)
						: project,
				);
			});
			try {
				const next = await reorderProjects(connectionId, projectIds);
				setProjects(next);
			} catch (error) {
				setProjects(previous);
				toast.error(t("project.sortFailed"), {
					description: userErrorMessage(error),
				});
			}
		},
		[projects, setProjects, t],
	);

	const handleDeleteProject = useCallback(
		async (projectId: string) => {
			const project = projects.find((candidate) => candidate.id === projectId);
			if (!project) return;
			try {
				const next = await removeProject(projectId);
				setProjects(next);
				onProjectsRemoved(new Set([projectId]), next);
				notifyProjectsChanged();
				toast.success(t("project.removed", { name: project.name }), {
					description: t("project.filesKept"),
				});
			} catch (error) {
				toast.error(t("project.removeFailed"), {
					description: userErrorMessage(error),
				});
			}
		},
		[onProjectsRemoved, projects, setProjects, t],
	);

	const handleDeleteConnection = useCallback(
		async (connectionId: string) => {
			if (connectionId === "local") return;
			const connection =
				connectionCatalog.find((candidate) => candidate.id === connectionId) ??
				projects.find((project) => project.connection.id === connectionId)
					?.connection;
			if (!connection) return;

			const affectedProjectIds = new Set(
				projects
					.filter((project) => project.connection.id === connectionId)
					.map((project) => project.id),
			);
			try {
				if (connection.kind.type === "wsl") {
					await removeWslConnection(connectionId);
				} else if (connection.kind.type === "ssh") {
					await removeSshConnection(connectionId);
				}
				const nextProjects = await listProjects();
				setConnectionShownInHome(connectionId, false);
				setProjects(nextProjects);
				onProjectsRemoved(affectedProjectIds, nextProjects);
				notifyProjectsChanged();
				toast.success(
					t("project.removed", { name: connectionLabel(connection) }),
					{ description: t("project.connectionRecordsRemoved") },
				);
			} catch (error) {
				toast.error(t("project.removeConnectionFailed"), {
					description: userErrorMessage(error),
				});
			}
		},
		[connectionCatalog, onProjectsRemoved, projects, setProjects, t],
	);

	return {
		addProjectOpen,
		setAddProjectOpen,
		addProjectConnectionId,
		handleAddProject,
		handleReorderProjects,
		handleDeleteProject,
		handleDeleteConnection,
	};
}
