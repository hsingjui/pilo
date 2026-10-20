import { invoke, isTauri } from "@tauri-apps/api/core";

import { i18n } from "../../i18n/index.ts";
import type { Project } from "@/lib/api/projects";
import {
	fileLinkPreviewKind,
	resolveMarkdownFileUrl,
} from "@/lib/chat/chat-markdown-links";
import type { WorkspaceFile } from "@/lib/project-workspace";

/** null means the system default application was opened; text is returned for tabs. */
export async function openFileLink(
	project: Pick<Project, "id" | "connection"> | null,
	value: string,
): Promise<WorkspaceFile | null> {
	if (!isTauri()) throw new Error(i18n.t("chat.fileLinkWebUnsupported"));
	if (!project) throw new Error(i18n.t("chat.fileLinkNoProject"));
	const url = resolveMarkdownFileUrl(value);
	if (!url) throw new Error(i18n.t("chat.fileLinkInvalid"));
	return invoke<WorkspaceFile | null>("project_file_link_open", {
		projectId: project.id,
		url,
		preview:
			fileLinkPreviewKind(decodeURIComponent(new URL(url).pathname)) !== null,
	});
}
