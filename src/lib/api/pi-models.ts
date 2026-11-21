import {
	probeProjectPiModels,
	type PiModelProbeTransport,
} from "./pi-models-probe";
import type { ProjectPiModels } from "./pi-models-types";

export * from "./pi-models-types";
export type {
	PiModelProbeClient,
	PiModelProbeTransport,
} from "./pi-models-probe";

type ProjectPiModelsListener = (snapshot: ProjectPiModels) => void;

const modelCache = new Map<string, ProjectPiModels>();
const pendingRefreshes = new Map<string, Promise<ProjectPiModels>>();
const listeners = new Map<string, Set<ProjectPiModelsListener>>();

function publishProjectPiModels(snapshot: ProjectPiModels): ProjectPiModels {
	const current = modelCache.get(snapshot.projectId);
	if (current && current.refreshedAtMs >= snapshot.refreshedAtMs)
		return current;
	modelCache.set(snapshot.projectId, snapshot);
	for (const listener of listeners.get(snapshot.projectId) ?? []) {
		listener(snapshot);
	}
	return snapshot;
}

export function getCachedProjectPiModels(
	projectId: string,
): ProjectPiModels | null {
	return modelCache.get(projectId) ?? null;
}

export function isProjectPiModelsIncomplete(
	snapshot: ProjectPiModels,
): boolean {
	return (
		snapshot.commands == null ||
		snapshot.defaultThinkingLevel === null ||
		snapshot.models.some(
			(model) =>
				model.defaultThinkingLevel === undefined ||
				model.thinkingLevels === undefined ||
				(model.reasoning && model.thinkingLevels.length === 0) ||
				model.scopeOrder === undefined ||
				model.scopeThinkingLevel === undefined,
		)
	);
}

export function subscribeProjectPiModels(
	projectId: string,
	listener: ProjectPiModelsListener,
): () => void {
	const projectListeners = listeners.get(projectId) ?? new Set();
	projectListeners.add(listener);
	listeners.set(projectId, projectListeners);
	return () => {
		projectListeners.delete(listener);
		if (projectListeners.size === 0) listeners.delete(projectId);
	};
}

function traceModelCatalog(stage: string, detail: Record<string, unknown>) {
	const payload = {
		stage: `model_catalog.${stage}`,
		...detail,
	};
	console.info("[model-catalog]", payload);
}

export function refreshProjectPiModels(
	projectId: string,
	transport: PiModelProbeTransport,
): Promise<ProjectPiModels> {
	const pending = pendingRefreshes.get(projectId);
	if (pending) return pending;

	const refresh = probeProjectPiModels(projectId, transport, {
		onTrace: traceModelCatalog,
	}).then((snapshot) => publishProjectPiModels(snapshot));

	pendingRefreshes.set(projectId, refresh);
	const clearPending = () => {
		if (pendingRefreshes.get(projectId) === refresh) {
			pendingRefreshes.delete(projectId);
		}
	};
	void refresh.then(clearPending, clearPending);
	return refresh;
}
