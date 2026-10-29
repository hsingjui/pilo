import type { PiModel, PiThinkingLevel } from "@/lib/api/pi-runtime";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@/lib/project-model-scope";

export function piModelsMatch(
	a: Pick<PiModel, "provider" | "id"> | null | undefined,
	b: Pick<PiModel, "provider" | "id"> | null | undefined,
): boolean {
	return Boolean(a && b && a.provider === b.provider && a.id === b.id);
}
/**
 * 一个模型 id 的路由前缀层：`cline-pass/deepseek-v4.1-flash` →
 * [`cline-pass/deepseek-v4.1-flash`, `deepseek-v4.1-flash`]。
 *
 * Pi 的会话历史记录的是带路由前缀的别名，模型目录里则是裸 id（也可能反过来），
 * 只做全等比较会匹配不上，调用方就退化成没有能力信息的占位模型。
 */
function modelIdLayers(id: string): string[] {
	const layers = [id];
	let rest = id;
	for (let slash = rest.indexOf("/"); slash !== -1; slash = rest.indexOf("/")) {
		rest = rest.slice(slash + 1);
		layers.push(rest);
	}
	return layers;
}

export function findMatchingPiModel(
	models: readonly PiModel[],
	model: Pick<PiModel, "provider" | "id"> | null | undefined,
): PiModel | null {
	if (!model) return null;
	const exact = models.find((candidate) => piModelsMatch(candidate, model));
	if (exact) return exact;
	// 同一个 id 的不同写法一定属于同一个 provider，跨 provider 不做模糊匹配。
	const requestedLayers = new Set(modelIdLayers(model.id));
	return (
		models.find((candidate) => {
			if (candidate.provider !== model.provider) return false;
			if (requestedLayers.has(candidate.id)) return true;
			return modelIdLayers(candidate.id).includes(model.id);
		}) ?? null
	);
}

export function getPiQuickCycleModels(models: readonly PiModel[]): PiModel[] {
	const scoped: PiModel[] = [];
	for (const model of models) {
		const scopeOrder = model.scopeOrder;
		if (typeof scopeOrder !== "number") continue;
		const insertAt = scoped.findIndex(
			(candidate) => (candidate.scopeOrder ?? 0) > scopeOrder,
		);
		if (insertAt === -1) scoped.push(model);
		else scoped.splice(insertAt, 0, model);
	}
	return scoped.length > 0 ? scoped : [...models];
}

export function isPiScopeCatalogResolved(models: readonly PiModel[]): boolean {
	return models.every(
		(model) =>
			model.scopeOrder !== undefined && model.scopeThinkingLevel !== undefined,
	);
}

export function getProjectScopeModels(
	models: readonly PiModel[],
	scope: ProjectModelScope | null,
	catalog: readonly PiModel[] = models,
): PiModel[] {
	if (!scope) return [];
	if (scope.models === null)
		return getPiQuickCycleModels(catalog).flatMap((entry) => {
			const model = findMatchingPiModel(models, entry);
			return model
				? [
						{
							...entry,
							...model,
							scopeOrder: entry.scopeOrder,
							scopeThinkingLevel: entry.scopeThinkingLevel,
						},
					]
				: [];
		});
	return scope.models.flatMap((entry, scopeOrder) => {
		const model = findMatchingPiModel(models, {
			provider: entry.provider,
			id: entry.modelId,
		});
		return model
			? [{ ...model, scopeOrder, scopeThinkingLevel: entry.thinkingLevel }]
			: [];
	});
}

export function getProjectScopeDefaultModel(
	models: readonly PiModel[],
	scope: ProjectModelScope | null,
): PiModel | null {
	const scopeOrder = scope?.models?.findIndex((entry) => entry.isDefault) ?? -1;
	const entry = scope?.models?.[scopeOrder];
	if (!entry) return null;
	const model = findMatchingPiModel(models, {
		provider: entry.provider,
		id: entry.modelId,
	});
	return model
		? { ...model, scopeOrder, scopeThinkingLevel: entry.thinkingLevel }
		: null;
}

export function getProjectScopeDraft(
	models: readonly PiModel[],
	scope: ProjectModelScope,
): ProjectScopedModel[] {
	return (
		scope.models?.map((entry) => ({
			...entry,
			isDefault: entry.isDefault ?? false,
		})) ??
		getPiQuickCycleModels(models).map((model) => ({
			provider: model.provider,
			modelId: model.id,
			thinkingLevel: model.scopeThinkingLevel ?? null,
			isDefault: false,
		}))
	);
}

/** The input is already the effective Scope; never fall back to all models. */
export function getNextPiScopeModel(
	models: readonly PiModel[],
	currentModel: PiModel | null,
): PiModel | null {
	if (models.length === 0) return null;
	const index = models.findIndex((model) => piModelsMatch(model, currentModel));
	const next = models[(index + 1) % models.length] ?? null;
	return piModelsMatch(next, currentModel) ? null : next;
}

/** Keep Host-resolved Scope/thinking metadata when live RPC returns bare models. */
export function reconcilePiModelCatalog(
	models: readonly PiModel[],
	catalog: readonly PiModel[],
): PiModel[] {
	return models.map((model) => ({
		...findMatchingPiModel(catalog, model),
		...model,
	}));
}

export function getNextPiQuickCycleModel(
	models: readonly PiModel[],
	currentModel: Pick<PiModel, "provider" | "id"> | null | undefined,
): PiModel | null {
	const cycleModels = getPiQuickCycleModels(models);
	if (cycleModels.length <= 1) return null;

	let currentIndex = currentModel
		? cycleModels.findIndex((model) => piModelsMatch(model, currentModel))
		: -1;
	if (currentIndex === -1) currentIndex = 0;
	return cycleModels[(currentIndex + 1) % cycleModels.length] ?? null;
}

export function getPiModelThinkingLevels(
	model: PiModel | null | undefined,
): readonly PiThinkingLevel[] {
	return model?.thinkingLevels ?? [];
}

export function getPiQuickCycleThinkingLevel(
	model: PiModel,
): PiThinkingLevel | null {
	return typeof model.scopeOrder === "number"
		? (model.scopeThinkingLevel ?? model.defaultThinkingLevel ?? null)
		: (model.defaultThinkingLevel ?? null);
}
