import { invoke } from "@tauri-apps/api/core";

import { createChatSessionClient } from "@/lib/chat-session-client";
import {
	PI_MODEL_CATALOG_COMMAND,
	PI_MODEL_CATALOG_EXTENSION_SOURCE,
	PI_MODEL_CATALOG_TITLE,
} from "@/lib/pi-model-catalog-extension";
import {
	type PiAgentState,
	type PiModel,
	type PiThinkingLevel,
	PI_THINKING_LEVELS,
} from "@/lib/pi-runtime";

export const PROJECT_PI_MODELS_TTL_MS = 60 * 60 * 1000;
const STARTUP_REFRESH_CONCURRENCY = 1;
/** Bounded wait for the catalog extension to answer before falling back to RPC. */
const MODEL_CATALOG_TIMEOUT_MS = 20_000;
const CATALOG_ERROR_TITLE = "pilo-model-catalog:error";

export type ProjectPiModels = {
	projectId: string;
	models: PiModel[];
	defaultModel: PiModel | null;
	defaultThinkingLevel: PiThinkingLevel | null;
	refreshedAtMs: number;
};

type PiModelCatalogEntry = PiModel & {
	defaultThinkingLevel: PiThinkingLevel | null;
	thinkingLevels: PiThinkingLevel[] | null;
	scopeOrder: number | null;
	scopeThinkingLevel: PiThinkingLevel | null;
};

type PiModelCatalogPayload = {
	models: PiModelCatalogEntry[];
	baselineModel: PiModel | null;
	baselineThinkingLevel: PiThinkingLevel | null;
};

type PiModelCatalogResult = Pick<
	ProjectPiModels,
	"models" | "defaultModel" | "defaultThinkingLevel"
>;

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

function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
	return (
		typeof value === "string" &&
		(PI_THINKING_LEVELS as string[]).includes(value)
	);
}

function parsePiModelCatalogPayload(raw: string): PiModelCatalogResult {
	const payload = JSON.parse(raw) as PiModelCatalogPayload;
	if (
		!payload ||
		!Array.isArray(payload.models) ||
		payload.models.length === 0
	) {
		throw new Error("model catalog payload has no models");
	}
	const models = payload.models.map((entry) => {
		if (
			!entry ||
			typeof entry.provider !== "string" ||
			typeof entry.id !== "string" ||
			!Array.isArray(entry.thinkingLevels) ||
			!entry.thinkingLevels.every(isPiThinkingLevel) ||
			(entry.defaultThinkingLevel !== null &&
				!isPiThinkingLevel(entry.defaultThinkingLevel)) ||
			(entry.scopeOrder !== null && typeof entry.scopeOrder !== "number") ||
			(entry.scopeThinkingLevel !== null &&
				!isPiThinkingLevel(entry.scopeThinkingLevel))
		) {
			throw new Error("model catalog payload entry is malformed");
		}
		return entry as PiModel;
	});
	const baselineThinkingLevel = payload.baselineThinkingLevel;
	if (
		baselineThinkingLevel !== null &&
		!isPiThinkingLevel(baselineThinkingLevel)
	) {
		throw new Error(
			"model catalog payload has malformed baseline thinking level",
		);
	}
	return {
		models,
		defaultModel:
			models.find((model) => modelsMatch(model, payload.baselineModel)) ??
			payload.baselineModel,
		defaultThinkingLevel: baselineThinkingLevel,
	};
}

/**
 * Resolve the whole model catalog in one round trip through the probe
 * extension. Returns null whenever the extension path is unavailable (older
 * pilo-server, Pi without the command, timeout, malformed payload) so the
 * caller can fall back to the per-model RPC chain.
 */
async function fetchPiModelCatalogViaExtension(
	client: ReturnType<typeof createChatSessionClient>,
): Promise<PiModelCatalogResult | null> {
	let settle: (value: PiModelCatalogResult) => void;
	let fail: (error: unknown) => void;
	const catalog = new Promise<PiModelCatalogResult>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	let settled = false;
	const complete = (run: () => void) => {
		if (settled) return;
		settled = true;
		run();
	};
	const timeout = setTimeout(() => {
		complete(() => fail(new Error("model catalog extension timed out")));
	}, MODEL_CATALOG_TIMEOUT_MS);

	let unlisten: (() => void) | undefined;
	try {
		unlisten = await client.listen((event) => {
			if (event.type === "runtime_error") {
				complete(() => fail(new Error(event.message)));
				return;
			}
			if (
				event.type === "process_state" &&
				(event.state === "failed" || event.state === "stopped")
			) {
				complete(() => fail(new Error("Pi probe session ended unexpectedly")));
				return;
			}
			if (event.type !== "extension_ui_request") return;
			if (event.title === PI_MODEL_CATALOG_TITLE) {
				complete(() => {
					try {
						settle(parsePiModelCatalogPayload(event.message ?? ""));
					} catch (error) {
						fail(error);
					} finally {
						void client
							.respondToExtensionUi(event.id, { confirmed: true })
							.catch(() => undefined);
					}
				});
				return;
			}
			if (event.title === CATALOG_ERROR_TITLE) {
				complete(() => {
					void client
						.respondToExtensionUi(event.id, { confirmed: true })
						.catch(() => undefined);
					fail(new Error(event.message ?? "model catalog extension failed"));
				});
			}
		});
		await client.executePiCommand(PI_MODEL_CATALOG_COMMAND);
		return await catalog;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
		unlisten?.();
	}
}

export function refreshProjectPiModels(
	projectId: string,
): Promise<ProjectPiModels> {
	const pending = pendingRefreshes.get(projectId);
	if (pending) return pending;

	const sessionKey = `model-probe:${projectId}:${Date.now()}:${++probeSequence}`;
	// noSession 是必须的：探测只读模型列表和默认思考等级，不需要持久会话。
	// 否则 ensure() 会对无 sessionPath 的进程发 new_session，让 Pi 落盘一个
	// 空会话文件，被 watcher 索引后侧栏凭空多出一条会话。
	// extensions 让 pilo-server 以 --extension 只给这个探测进程加载目录扩展，
	// 不影响用户正常的 Pi 会话；扩展不可用时回退到逐模型 RPC 链。
	const client = createChatSessionClient(projectId, sessionKey, undefined, {
		noSession: true,
		owner: "model_probe",
		extensions: [PI_MODEL_CATALOG_EXTENSION_SOURCE],
	});
	const refresh = (async () => {
		try {
			await client.prepare();
			const extensionCatalog = await fetchPiModelCatalogViaExtension(client);
			if (extensionCatalog) {
				const snapshot = publishProjectPiModels({
					projectId,
					...extensionCatalog,
					refreshedAtMs: Date.now(),
				});
				try {
					await persistProjectPiModels(snapshot);
				} catch (error) {
					console.warn("Failed to persist refreshed Pi models", error);
				}
				return snapshot;
			}

			console.warn(
				"Pi model catalog extension unavailable; falling back to RPC probing",
			);
			await client.prepare();
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
			await client.dispose("model_probe_cleanup").catch((error) => {
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
