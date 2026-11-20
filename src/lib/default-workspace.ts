import { i18n } from "@/i18n";

export { isDefaultWorkspace } from "./api/projects-types";
import { isDefaultWorkspace } from "./api/projects-types";

export function defaultWorkspaceName<T extends { id: string; name: string }>(
	project: T,
): T {
	return isDefaultWorkspace(project)
		? { ...project, name: i18n.t("sidebar.defaultWorkspace") }
		: project;
}
