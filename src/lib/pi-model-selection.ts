import type { PiModel, PiThinkingLevel } from "@/lib/pi-runtime";

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
