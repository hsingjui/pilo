import { invoke, isTauri } from "@tauri-apps/api/core";

import { i18n } from "../../i18n/index.ts";
import type { Project } from "@/lib/api/projects";

export function openHtmlReport(
	project: Pick<Project, "id" | "connection"> | null,
	url: string,
): Promise<void> {
	if (!isTauri())
		return Promise.reject(new Error(i18n.t("chat.fileLinkWebUnsupported")));
	if (!project)
		return Promise.reject(new Error(i18n.t("chat.fileLinkNoProject")));
	return invoke<void>("project_html_report_open", {
		projectId: project.id,
		url,
	});
}
