import type { PiloRuntimeEvent } from "@/lib/api/pi-runtime";

export type PiExtensionDialogRequest = Extract<
	PiloRuntimeEvent,
	{ type: "extension_ui_request" }
>;

export function projectMcpApprovalServer(
	request: PiExtensionDialogRequest,
): string | null {
	if (request.method !== "confirm" || !request.title || !request.message) {
		return null;
	}
	if (!request.message.startsWith("Project config:")) return null;
	const match = request.title.match(
		/^Allow project MCP server [“"](.+?)[”"]\?$/,
	);
	return match?.[1]?.trim() || null;
}

export function sameExtensionDialogRequest(
	left: PiExtensionDialogRequest,
	right: PiExtensionDialogRequest,
): boolean {
	if (left.id === right.id) return true;
	const server = projectMcpApprovalServer(left);
	return (
		server !== null &&
		server === projectMcpApprovalServer(right) &&
		left.message === right.message
	);
}
