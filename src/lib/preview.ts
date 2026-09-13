import { invoke } from "@tauri-apps/api/core";

export type PreviewInfo = {
	id: string;
	projectId: string;
	remotePort: number;
	localPort: number;
	url: string;
	tunneled: boolean;
};

export function detectProjectPreviewPorts(
	projectId: string,
): Promise<number[]> {
	return invoke("project_preview_ports", { projectId });
}

export function openProjectPreview(
	projectId: string,
	port: number,
): Promise<PreviewInfo> {
	return invoke("project_preview_open", { projectId, port });
}

export function closeProjectPreview(previewId: string): Promise<void> {
	return invoke("project_preview_close", { previewId });
}
