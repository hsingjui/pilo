import { invoke } from "@tauri-apps/api/core";

export type PreviewInfo = {
	id: string;
	workspaceId: string;
	remotePort: number;
	localPort: number;
	url: string;
	tunneled: boolean;
};

export function detectWorkspacePreviewPorts(
	workspaceId: string,
): Promise<number[]> {
	return invoke("workspace_preview_ports", { workspaceId });
}

export function openWorkspacePreview(
	workspaceId: string,
	port: number,
): Promise<PreviewInfo> {
	return invoke("workspace_preview_open", { workspaceId, port });
}

export function closeWorkspacePreview(previewId: string): Promise<void> {
	return invoke("workspace_preview_close", { previewId });
}
