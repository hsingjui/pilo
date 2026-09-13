import { createChatSessionClient } from "@/lib/chat-session-client";
import type { PiModel } from "@/lib/pi-runtime";

export type ProjectPiModels = {
	models: PiModel[];
	refreshedAtMs: number;
};

const modelCache = new Map<string, ProjectPiModels>();
const pendingRefreshes = new Map<string, Promise<ProjectPiModels>>();
let probeSequence = 0;

export function getCachedProjectPiModels(
	projectId: string,
): ProjectPiModels | null {
	return modelCache.get(projectId) ?? null;
}

export function cacheProjectPiModels(
	projectId: string,
	models: PiModel[],
): ProjectPiModels {
	const snapshot = { models, refreshedAtMs: Date.now() };
	modelCache.set(projectId, snapshot);
	return snapshot;
}

export function refreshProjectPiModels(
	projectId: string,
): Promise<ProjectPiModels> {
	const pending = pendingRefreshes.get(projectId);
	if (pending) return pending;

	const sessionKey = `model-probe:${projectId}:${Date.now()}:${++probeSequence}`;
	const client = createChatSessionClient(projectId, sessionKey);
	const refresh = (async () => {
		try {
			await client.ensure();
			const result = await client.getAvailablePiModels();
			return cacheProjectPiModels(projectId, result.models);
		} finally {
			await client.stop().catch((error) => {
				console.warn("Failed to stop Pi model probe session", error);
			});
		}
	})();

	pendingRefreshes.set(projectId, refresh);
	const clearPending = () => {
		if (pendingRefreshes.get(projectId) === refresh) {
			pendingRefreshes.delete(projectId);
		}
	};
	void refresh.then(clearPending, clearPending);
	return refresh;
}
