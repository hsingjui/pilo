import { invoke, isTauri } from "@tauri-apps/api/core";

import { createChatSessionClient } from "@/lib/api/chat-session-client";
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

const STARTUP_REFRESH_CONCURRENCY = 1;

type ProjectPiModelsListener = (snapshot: ProjectPiModels) => void;

const modelCache = new Map<string, ProjectPiModels>();
const pendingRefreshes = new Map<string, Promise<ProjectPiModels>>();
const listeners = new Map<string, Set<ProjectPiModelsListener>>();
let hydrationPromise: Promise<void> | null = null;

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

async function persistProjectPiModels(
	snapshot: ProjectPiModels,
): Promise<ProjectPiModels> {
	return invoke<ProjectPiModels>("project_model_cache_set", {
		projectId: snapshot.projectId,
		models: snapshot.models,
		commands: snapshot.commands,
		defaultModel: snapshot.defaultModel,
		defaultThinkingLevel: snapshot.defaultThinkingLevel,
		refreshedAtMs: snapshot.refreshedAtMs,
	});
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

export async function hydrateProjectPiModels(): Promise<void> {
	if (hydrationPromise) return hydrationPromise;
	hydrationPromise = invoke<ProjectPiModels[]>("project_model_cache_list")
		.then((snapshots) => {
			for (const snapshot of snapshots) publishProjectPiModels(snapshot);
		})
		.catch((error) => {
			hydrationPromise = null;
			throw error;
		});
	return hydrationPromise;
}

function traceModelCatalog(stage: string, detail: Record<string, unknown>) {
	const payload = {
		stage: `model_catalog.${stage}`,
		...detail,
	};
	console.info("[model-catalog]", payload);
	if (isTauri()) {
		void invoke("debug_runtime_trace_log", {
			payload: JSON.stringify(payload),
		}).catch(() => undefined);
	}
}

export function refreshProjectPiModels(
	projectId: string,
	transport?: PiModelProbeTransport,
): Promise<ProjectPiModels> {
	const pending = pendingRefreshes.get(projectId);
	if (pending) return pending;

	const effectiveTransport: PiModelProbeTransport = transport ?? {
		cached: getCachedProjectPiModels(projectId),
		createClient: (project, sessionKey) =>
			createChatSessionClient(project, sessionKey, undefined, {
				noSession: true,
				owner: "model_probe",
				builtinExtensions: [{ id: "model-catalog" }],
			}),
		persist: persistProjectPiModels,
	};
	const refresh = probeProjectPiModels(projectId, effectiveTransport, {
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

export async function refreshAllProjectPiModels(
	projectIds: readonly string[],
): Promise<void> {
	const queue = [...new Set(projectIds)];
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		const projectId = queue[nextIndex++];
		if (!projectId) return;
		try {
			await refreshProjectPiModels(projectId);
		} catch (error) {
			console.warn(`Failed to refresh Pi models for ${projectId}`, error);
		}
		return worker();
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(STARTUP_REFRESH_CONCURRENCY, queue.length) },
			() => worker(),
		),
	);
}
