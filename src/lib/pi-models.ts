import { createChatSessionClient } from "@/lib/chat-session-client";
import type { PiModel } from "@/lib/pi-runtime";

export type WorkspacePiModels = {
	models: PiModel[];
	refreshedAtMs: number;
};

const modelCache = new Map<string, WorkspacePiModels>();
const pendingRefreshes = new Map<string, Promise<WorkspacePiModels>>();
let probeSequence = 0;

export function getCachedWorkspacePiModels(
	workspaceId: string,
): WorkspacePiModels | null {
	return modelCache.get(workspaceId) ?? null;
}

export function cacheWorkspacePiModels(
	workspaceId: string,
	models: PiModel[],
): WorkspacePiModels {
	const snapshot = { models, refreshedAtMs: Date.now() };
	modelCache.set(workspaceId, snapshot);
	return snapshot;
}

export function refreshWorkspacePiModels(
	workspaceId: string,
): Promise<WorkspacePiModels> {
	const pending = pendingRefreshes.get(workspaceId);
	if (pending) return pending;

	const sessionKey = `model-probe:${workspaceId}:${Date.now()}:${++probeSequence}`;
	const client = createChatSessionClient(workspaceId, sessionKey);
	const refresh = (async () => {
		try {
			await client.ensure();
			const result = await client.getAvailablePiModels();
			return cacheWorkspacePiModels(workspaceId, result.models);
		} finally {
			await client.stop().catch((error) => {
				console.warn("Failed to stop Pi model probe session", error);
			});
		}
	})();

	pendingRefreshes.set(workspaceId, refresh);
	const clearPending = () => {
		if (pendingRefreshes.get(workspaceId) === refresh) {
			pendingRefreshes.delete(workspaceId);
		}
	};
	void refresh.then(clearPending, clearPending);
	return refresh;
}
