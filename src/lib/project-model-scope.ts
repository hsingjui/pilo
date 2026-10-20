import type { PiModel, PiThinkingLevel } from "@/lib/api/pi-runtime-types";

export type ProjectScopedModel = {
	provider: string;
	modelId: string;
	thinkingLevel: PiThinkingLevel | null;
	/** Omitted in legacy data; only true marks a new-chat default. */
	isDefault?: boolean;
};

export type ModelScopeControls = {
	projectId: string;
	scope: ProjectModelScope | null;
	models: readonly PiModel[];
	availableModels: readonly PiModel[];
	catalogReady: boolean;
	loading: boolean;
	error: string | null;
	saving: boolean;
	refresh: () => Promise<void>;
	save: (models: ProjectScopedModel[] | null) => Promise<ProjectModelScope>;
};

export type ProjectModelScope = {
	projectId: string;
	/** null inherits Pi; [] is an explicitly empty project override. */
	models: ProjectScopedModel[] | null;
	updatedAtMs: number;
};
