import { invoke } from "@tauri-apps/api/core";

import { createChatSessionClient } from "@/lib/chat-session-client";
import {
	type PiAgentState,
	type PiModel,
	type PiThinkingLevel,
} from "@/lib/pi-runtime";

export const PROJECT_PI_MODELS_TTL_MS = 60 * 60 * 1000;
const STARTUP_REFRESH_CONCURRENCY = 1;

export type ProjectPiModels = {
	projectId: string;
	models: PiModel[];
	defaultModel: PiModel | null;
	defaultThinkingLevel: PiThinkingLevel | null;
	refreshedAtMs: number;
};

type ProjectPiModelsListener = (snapshot: ProjectPiModels) => void;

const modelCache = new Map<string, ProjectPiModels>();
const pendingRefreshes = new Map<string, Promise<ProjectPiModels>>();
const listeners = new Map<string, Set<ProjectPiModelsListener>>();
let hydrationPromise: Promise<void> | null = null;
let probeSequence = 0;

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

export function isProjectPiModelsStale(
	snapshot: ProjectPiModels,
	now = Date.now(),
): boolean {
	return (
		snapshot.defaultThinkingLevel === null ||
		snapshot.models.some(
			(model) =>
				model.defaultThinkingLevel === undefined ||
				model.thinkingLevels === undefined ||
				(model.reasoning && model.thinkingLevels.length === 0) ||
				model.scopeOrder === undefined ||
				model.scopeThinkingLevel === undefined,
		) ||
		now - snapshot.refreshedAtMs >= PROJECT_PI_MODELS_TTL_MS
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

function modelsMatch(a: PiModel | null, b: PiModel | null): boolean {
	return Boolean(a && b && a.provider === b.provider && a.id === b.id);
}

function fallbackThinkingLevels(model: PiModel): PiThinkingLevel[] {
	return model.reasoning ? [] : ["off"];
}

function modelKey(model: Pick<PiModel, "provider" | "id">): string {
	return `${model.provider}\0${model.id}`;
}

type ScopedModelProfile = {
	order: number | null;
	thinkingLevel: PiThinkingLevel | null;
};

async function resolveScopedModelProfiles(
	client: ReturnType<typeof createChatSessionClient>,
	models: PiModel[],
	baseline: PiAgentState,
): Promise<Map<string, ScopedModelProfile>> {
	const profiles = new Map<string, ScopedModelProfile>(
		models.map((model) => [
			modelKey(model),
			{ order: null, thinkingLevel: null },
		]),
	);
	if (!baseline.model || models.length === 0) return profiles;

	try {
		const first = await client.cyclePiModel();
		if (!first) {
			// With more than one available model, a null cycle result means Pi has a
			// one-model scope. New RPC sessions start on that scoped model.
			if (models.length > 1) {
				profiles.set(modelKey(baseline.model), {
					order: 0,
					thinkingLevel: baseline.thinkingLevel,
				});
			}
			return profiles;
		}

		if (!first.isScoped) return profiles;

		const scopedKeys: string[] = [modelKey(first.model)];
		const scopedThinkingLevels = new Map<string, PiThinkingLevel>([
			[modelKey(first.model), first.thinkingLevel],
		]);
		const collect = async (): Promise<void> => {
			if (scopedKeys.length > models.length) return;
			const next = await client.cyclePiModel();
			if (!next?.isScoped) return;
			const key = modelKey(next.model);
			if (scopedKeys.includes(key)) return;
			scopedKeys.push(key);
			scopedThinkingLevels.set(key, next.thinkingLevel);
			return collect();
		};
		await collect();

		// Pi's scope is circular. Rotate the discovered cycle so the startup model
		// remains first; this preserves enabledModels / --models ordering in the UI.
		const baselineKey = modelKey(baseline.model);
		const baselineIndex = scopedKeys.indexOf(baselineKey);
		const orderedKeys =
			baselineIndex > 0
				? [
						...scopedKeys.slice(baselineIndex),
						...scopedKeys.slice(0, baselineIndex),
					]
				: scopedKeys;
		for (const [index, key] of orderedKeys.entries()) {
			profiles.set(key, {
				order: index,
				thinkingLevel: scopedThinkingLevels.get(key) ?? null,
			});
		}
		return profiles;
	} catch (error) {
		console.warn("Failed to resolve Pi scoped models", error);
		return profiles;
	} finally {
		try {
			await client.setPiModel(baseline.model);
			await client.setPiThinkingLevel(baseline.thinkingLevel);
		} catch (error) {
			console.warn("Failed to restore Pi model after scope probe", error);
		}
	}
}

async function resolveModelThinkingProfiles(
	client: ReturnType<typeof createChatSessionClient>,
	models: PiModel[],
	baseline: PiAgentState,
	scopeProfiles: ReadonlyMap<string, ScopedModelProfile>,
): Promise<PiModel[]> {
	if (!baseline.model || models.length === 0) return models;

	const resolved: PiModel[] = [];
	const visit = async (index: number): Promise<void> => {
		const model = models[index];
		if (!model) return;

		try {
			// Resolve every model from the same initial Pi state. This matters when Pi has
			// no explicit per-model/global override: model switching then falls back to
			// the current level, so probing models as one chain could leak a clamp from
			// the previous model into the next model's cached default.
			await client.setPiModel(baseline.model!);
			await client.setPiThinkingLevel(baseline.thinkingLevel);
			if (!modelsMatch(model, baseline.model)) {
				await client.setPiModel(model);
			}
			const [state, thinking] = await Promise.all([
				client.getPiAgentState(),
				client.getAvailablePiThinkingLevels(),
			]);
			resolved.push({
				...model,
				defaultThinkingLevel: state.thinkingLevel,
				thinkingLevels: thinking.levels,
				scopeOrder: scopeProfiles.get(modelKey(model))?.order ?? null,
				scopeThinkingLevel:
					scopeProfiles.get(modelKey(model))?.thinkingLevel ?? null,
			});
		} catch (error) {
			console.warn(
				`Failed to resolve Pi thinking defaults for ${model.provider}/${model.id}`,
				error,
			);
			resolved.push({
				...model,
				defaultThinkingLevel: baseline.thinkingLevel,
				thinkingLevels: fallbackThinkingLevels(model),
				scopeOrder: scopeProfiles.get(modelKey(model))?.order ?? null,
				scopeThinkingLevel:
					scopeProfiles.get(modelKey(model))?.thinkingLevel ?? null,
			});
		}

		return visit(index + 1);
	};

	await visit(0);
	return resolved;
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
			const [result, state] = await Promise.all([
				client.getAvailablePiModels(),
				client.getPiAgentState(),
			]);
			const scopeProfiles = await resolveScopedModelProfiles(
				client,
				result.models,
				state,
			);
			const models = await resolveModelThinkingProfiles(
				client,
				result.models,
				state,
				scopeProfiles,
			);
			const defaultModel =
				models.find((model) => modelsMatch(model, state.model)) ?? state.model;
			const snapshot = publishProjectPiModels({
				projectId,
				models,
				defaultModel,
				defaultThinkingLevel: state.thinkingLevel,
				refreshedAtMs: Date.now(),
			});
			try {
				await persistProjectPiModels(snapshot);
			} catch (error) {
				console.warn("Failed to persist refreshed Pi models", error);
			}
			return snapshot;
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
