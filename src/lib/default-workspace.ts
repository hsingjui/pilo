import { i18n } from "@/i18n";

/** Built-in project IDs are stable across hiding, renaming and restarts. */
export function isDefaultWorkspace(project: { id: string }): boolean {
	return project.id.startsWith("default-workspace:");
}

export function defaultWorkspaceName<T extends { id: string; name: string }>(
	project: T,
): T {
	return isDefaultWorkspace(project)
		? { ...project, name: i18n.t("sidebar.defaultWorkspace") }
		: project;
}
