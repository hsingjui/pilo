import { useEffect, useMemo, useState } from "react";

import { firstProjectInConnectionOrder } from "@/components/app/app-chat-state";
import { CONNECTIONS_CHANGED_EVENT } from "@/lib/connection-events";
import { listConnectionCatalog } from "@/lib/connections";
import {
	HOME_CONNECTIONS_CHANGED_EVENT,
	listHomeConnectionIds,
} from "@/lib/home-connections";
import {
	getCachedProjectPiModels,
	hydrateProjectPiModels,
	isProjectPiModelsStale,
	refreshAllProjectPiModels,
} from "@/lib/pi-models";
import {
	connectionLabel,
	listProjects,
	PROJECTS_CHANGED_EVENT,
	type Project,
} from "@/lib/projects";
import type { Connection } from "@/lib/pi-runtime";

export function useAppCatalog(
	onProjectsLoaded?: (projects: Project[]) => void,
) {
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
		window.addEventListener(HOME_CONNECTIONS_CHANGED_EVENT, handleChanged);
		window.addEventListener(CONNECTIONS_CHANGED_EVENT, handleChanged);
		return () => {
			active = false;
			window.removeEventListener(HOME_CONNECTIONS_CHANGED_EVENT, handleChanged);
			window.removeEventListener(CONNECTIONS_CHANGED_EVENT, handleChanged);
		};
	}, []);

	useEffect(() => {
		if (projects.length === 0) return;
		const timer = window.setTimeout(() => {
			void hydrateProjectPiModels()
				.then(() => {
					const staleProjectIds = projects
						.filter((project) => {
							const cached = getCachedProjectPiModels(project.id);
							return !cached || isProjectPiModelsStale(cached);
						})
						.map((project) => project.id);
					if (staleProjectIds.length > 0) {
						void refreshAllProjectPiModels(staleProjectIds);
					}
				})
				.catch((error) =>
					console.warn("Failed to schedule Pi model refresh", error),
				);
		}, 15_000);
		return () => window.clearTimeout(timer);
	}, [projects]);

	useEffect(() => {
		if (projects.length === 0) return;
		const timer = window.setInterval(
			() => {
				void refreshAllProjectPiModels(projects.map((project) => project.id));
			},
			60 * 60 * 1000,
		);
		return () => window.clearInterval(timer);
	}, [projects]);

	const envs = useMemo(() => {
		const shown = listHomeConnectionIds();
		const byId = new Map<string, { id: string; name: string }>();
		for (const connection of connectionCatalog) {
			if (!shown.has(connection.id)) continue;
			byId.set(connection.id, {
				id: connection.id,
				name: connectionLabel(connection),
			});
		}
		const list = [...byId.values()];
		list.sort((a, b) => (a.id === "local" ? -1 : b.id === "local" ? 1 : 0));
		return list;
	}, [connectionCatalog]);

	const sidebarProjects = useMemo(
		() =>
			projects.map((project) => ({
				id: project.id,
				name: project.name,
				path: project.metadata.cwd,
				envId: project.connection.id,
				connectionType: project.connection.kind.type,
				piRuntime: project.piRuntime,
			})),
		[projects],
	);

	const firstProject = useMemo(
		() =>
			connectionsReady
				? firstProjectInConnectionOrder(
						projects,
						envs.map((env) => env.id),
					)
				: null,
		[connectionsReady, envs, projects],
	);

	return {
		projects,
		setProjects,
		projectsReady,
		connectionCatalog,
		connectionsReady,
		envs,
		sidebarProjects,
		firstProject,
	};
}
