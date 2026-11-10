import { useEffect, useMemo, useState } from "react";
import { isDefaultWorkspace } from "@/lib/default-workspace";
import { useTranslation } from "react-i18next";

import { firstProjectInConnectionOrder } from "@/components/app/app-chat-state";
import { CONNECTIONS_CHANGED_EVENT } from "@/lib/api/connection-events";
import { listConnectionCatalog } from "@/lib/api/connections";
import {
	getCachedProjectPiModels,
	hydrateProjectPiModels,
	isProjectPiModelsIncomplete,
	refreshAllProjectPiModels,
} from "@/lib/api/pi-models";
import {
	connectionLabel,
	listProjects,
	PROJECTS_CHANGED_EVENT,
	type Project,
} from "@/lib/api/projects";
import type { Connection } from "@/lib/api/pi-runtime";

export function useAppCatalog(
	onProjectsLoaded?: (projects: Project[]) => void,
) {
	const { t } = useTranslation();
	const [projects, setProjects] = useState<Project[]>([]);
	const [projectsReady, setProjectsReady] = useState(false);
	const [connectionCatalog, setConnectionCatalog] = useState<Connection[]>([]);
	const [connectionsReady, setConnectionsReady] = useState(false);

	useEffect(() => {
		void hydrateProjectPiModels().catch((error) => {
			console.warn("Failed to hydrate Pi model cache", error);
		});
	}, []);

	useEffect(() => {
		let active = true;
		const load = async () => {
			try {
				const next = await listProjects();
				if (active) {
					setProjects(next);
					onProjectsLoaded?.(next);
				}
			} catch (error) {
				console.error("Failed to load projects", error);
			} finally {
				if (active) setProjectsReady(true);
			}
		};
		void load();
		const handleChanged = () => void load();
		window.addEventListener(PROJECTS_CHANGED_EVENT, handleChanged);
		window.addEventListener(CONNECTIONS_CHANGED_EVENT, handleChanged);
		return () => {
			active = false;
			window.removeEventListener(PROJECTS_CHANGED_EVENT, handleChanged);
			window.removeEventListener(CONNECTIONS_CHANGED_EVENT, handleChanged);
		};
	}, [onProjectsLoaded]);

	useEffect(() => {
		let active = true;
		const load = async () => {
			try {
				const next = await listConnectionCatalog();
				if (active) setConnectionCatalog(next);
			} catch (error) {
				console.error("Failed to load connections", error);
			} finally {
				if (active) setConnectionsReady(true);
			}
		};
		void load();
		const handleChanged = () => void load();
		window.addEventListener(CONNECTIONS_CHANGED_EVENT, handleChanged);
		return () => {
			active = false;
			window.removeEventListener(CONNECTIONS_CHANGED_EVENT, handleChanged);
		};
	}, []);

	const envs = useMemo(() => {
		const byId = new Map<string, { id: string; name: string }>();
		for (const connection of connectionCatalog) {
			if (!connection.shownInHome) continue;
			byId.set(connection.id, {
				id: connection.id,
				name: connectionLabel(connection),
			});
		}
		const list = [...byId.values()];
		list.sort((a, b) => (a.id === "local" ? -1 : b.id === "local" ? 1 : 0));
		return list;
	}, [connectionCatalog]);

	// 主页（侧边栏可见连接）下展示的项目。输入框上方的项目切换只应列出这些项目。
	const homeProjects = useMemo(() => {
		const visible = new Set(envs.map((env) => env.id));
		return projects.filter((project) => visible.has(project.connection.id));
	}, [envs, projects]);

	useEffect(() => {
		if (homeProjects.length === 0) return;
		const timer = window.setTimeout(() => {
			void hydrateProjectPiModels()
				.then(() => {
					const incompleteProjectIds = homeProjects
						.filter((project) => {
							if (
								isDefaultWorkspace(project) &&
								project.metadata.refreshedAtMs === 0
							)
								return false;
							const cached = getCachedProjectPiModels(project.id);
							return !cached || isProjectPiModelsIncomplete(cached);
						})
						.map((project) => project.id);
					if (incompleteProjectIds.length > 0) {
						void refreshAllProjectPiModels(incompleteProjectIds);
					}
				})
				.catch((error) =>
					console.warn("Failed to schedule Pi model refresh", error),
				);
		}, 15_000);
		return () => window.clearTimeout(timer);
	}, [homeProjects]);

	const sidebarProjects = useMemo(
		() =>
			projects.map((project) => ({
				id: project.id,
				name: isDefaultWorkspace(project)
					? t("sidebar.defaultWorkspace")
					: project.name,
				path: project.metadata.cwd,
				envId: project.connection.id,
				connectionType: project.connection.kind.type,
			})),
		[projects, t],
	);

	const firstProject = useMemo(
		() =>
			connectionsReady
				? firstProjectInConnectionOrder(
						homeProjects,
						envs.map((env) => env.id),
					)
				: null,
		[connectionsReady, envs, homeProjects],
	);

	return {
		projects,
		setProjects,
		projectsReady,
		connectionCatalog,
		connectionsReady,
		envs,
		homeProjects,
		sidebarProjects,
		firstProject,
	};
}
