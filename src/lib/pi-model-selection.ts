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

export function findMatchingPiModel(
	models: readonly PiModel[],
	model: Pick<PiModel, "provider" | "id"> | null | undefined,
): PiModel | null {
	if (!model) return null;
	return models.find((candidate) => piModelsMatch(candidate, model)) ?? null;
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
	const first = scope?.models?.[0];
	if (!first) return null;
	const model = findMatchingPiModel(models, {
		provider: first.provider,
		id: first.modelId,
	});
	return model
		? { ...model, scopeOrder: 0, scopeThinkingLevel: first.thinkingLevel }
		: null;
}

export function getProjectScopeDraft(
	models: readonly PiModel[],
	scope: ProjectModelScope,
): ProjectScopedModel[] {
	return (
		scope.models?.map((entry) => ({ ...entry })) ??
		getPiQuickCycleModels(models).map((model) => ({
			provider: model.provider,
			modelId: model.id,
			thinkingLevel: model.scopeThinkingLevel ?? null,
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
