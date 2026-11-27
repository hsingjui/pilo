import { type Accessor, computed, effect, untracked } from "nsh";

import type { AppStore } from "../state/app-store";
import { t } from "./i18n";
import { sidebarSessions } from "./sidebar-projects";

export type ArchiveView = { projectId?: string };

export function useArchivedSessions(
	store: AppStore,
	view: Accessor<ArchiveView | null>,
) {
	const projects = computed(() => store.state().projects);
	const scopedProjects = computed(() => {
		const scope = view();
		if (!scope) return [];
		return scope.projectId === undefined
			? projects()
			: projects().filter((project) => project.id === scope.projectId);
	});
	effect(() => {
		const projects = scopedProjects();
		const { sessionIndexes } = untracked(store.state);
		for (const project of projects) {
			const index = sessionIndexes[project.id];
			if (!index || index.status === "failed")
				void store.loadCachedSessions(project.id);
		}
	});
	const indexes = computed(() => store.state().sessionIndexes);
	const groups = computed(() => {
		const state = store.state();
		return scopedProjects()
			.map((project) => ({
				project,
				sessions: sidebarSessions(
					state,
					project.id,
					t("app.newChat"),
					"archived",
				).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
			}))
			.filter(({ sessions }) => sessions.length > 0)
			.sort(
				(a, b) =>
					(b.sessions[0]?.archivedAt ?? 0) - (a.sessions[0]?.archivedAt ?? 0),
			);
	});
	const loading = computed(() =>
		scopedProjects().some(({ id }) => {
			const status = indexes()[id]?.status;
			return status === undefined || status === "loading";
		}),
	);
	const failed = computed(() =>
		scopedProjects().some(({ id }) => indexes()[id]?.status === "failed"),
	);
	return { groups, loading, failed };
}
