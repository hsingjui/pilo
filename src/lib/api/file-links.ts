import { i18n } from "../../i18n/index.ts";
import type { Project } from "@/lib/api/projects";
import type { WorkspaceFile } from "@/lib/project-workspace";

/** WebUI cannot open local files yet; null would mean a system application opened it. */
export async function openFileLink(
	_project: Pick<Project, "id" | "connection"> | null,
	_value: string,
): Promise<WorkspaceFile | null> {
	throw new Error(i18n.t("chat.fileLinkWebUnsupported"));
}
