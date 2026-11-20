import { type Accessor, signal, Text, View } from "nsh";

import type { ProjectPiModels } from "@/lib/api/pi-models-types";
import type { Project } from "@/lib/api/projects-types";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@/lib/project-model-scope";
import type { AppState } from "../state/app-state";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Switch } from "../ui/switch";
import { modelKey } from "./connection-settings";
import { SettingsRow, SettingsSection, SettingsStatus } from "./layout";
import type { SettingsClient } from "./settings-dialog";

/**
 * Model catalog per project: the cached Pi catalog with a refresh, and the
 * project's model scope — a `null` scope inherits every model Pi reports.
 */
export function ModelCatalogPane(props: {
	state: Accessor<AppState>;
	client: SettingsClient;
}) {
	const catalogs = signal<Record<string, ProjectPiModels | null>>({});
	const scopes = signal<Record<string, ProjectModelScope>>({});
	const refreshing = signal<Record<string, boolean>>({});
	const loaded = new Set<string>();
	const ensure = (projectId: string) => {
		if (loaded.has(projectId)) return;
		loaded.add(projectId);
		Promise.all([
			props.client.loadModels(projectId),
			props.client.loadModelScope(projectId),
		])
			.then(([catalog, scope]) => {
				catalogs.set({ ...catalogs(), [projectId]: catalog });
				scopes.set({ ...scopes(), [projectId]: scope });
			})
			.catch((error: unknown) => {
				console.error(String(error));
			});
	};
	const saveScope = (project: Project, models: ProjectScopedModel[] | null) => {
		props.client
			.saveModelScope(project.id, models)
			.then((scope) => scopes.set({ ...scopes(), [project.id]: scope }))
			.catch((error: unknown) => {
				console.error(String(error));
			});
	};
	const refresh = (project: Project) => {
		refreshing.set({ ...refreshing(), [project.id]: true });
		props.client
			.loadConnectionModels(project.connection.id)
			.then((models) => {
				const previous = catalogs()[project.id];
				return props.client.saveModels({
					projectId: project.id,
					models,
					commands: previous?.commands ?? null,
					defaultModel: previous?.defaultModel ?? null,
					defaultThinkingLevel: previous?.defaultThinkingLevel ?? null,
					refreshedAtMs: Date.now(),
				});
			})
			.then((catalog) => catalogs.set({ ...catalogs(), [project.id]: catalog }))
			.catch((error: unknown) => {
				console.error(t("settings.refreshModelsFailed"), error);
			})
			.finally(() => refreshing.set({ ...refreshing(), [project.id]: false }));
	};
	return (
		<View class="gap-3">
			{() =>
				props.state().projects.map((project) => {
					ensure(project.id);
					const catalog = () => catalogs()[project.id];
					const scope = () => scopes()[project.id];
					const scoped = () =>
						new Set(
							(scope()?.models ?? []).map((entry) =>
								modelKey(entry.provider, entry.modelId),
							),
						);
					return (
						<SettingsSection
							title={project.name}
							headerRight={
								scope()?.models ? (
									<SettingsStatus>
										{t("settings.modelCatalogScoped", {
											count: scope()!.models!.length,
										})}
									</SettingsStatus>
								) : null
							}
							actions={
								<View class="flex-row items-center gap-2">
									{!scope()?.models ? null : (
										<Button
											testID={`settings-catalog-inherit-${project.id}`}
											variant="ghost"
											onPress={() => saveScope(project, null)}
										>
											{t("settings.modelCatalogInherit")}
										</Button>
									)}
									<Button
										testID={`settings-catalog-refresh-${project.id}`}
										variant="ghost"
										size="icon"
										class="size-8"
										accessibilityLabel={t("settings.refreshModels")}
										onPress={() => refresh(project)}
									>
										<Icon
											name="RefreshCw"
											size={14}
											class={
												refreshing()[project.id] ? "animate-spin" : undefined
											}
										/>
									</Button>
								</View>
							}
						>
							{() => {
								const models = catalog()?.models ?? [];
								if (models.length === 0)
									return (
										<View class="px-3 py-4">
											<Text class="text-sm text-muted-foreground">
												{t("settings.modelCatalogEmpty")}
											</Text>
										</View>
									);
								return models.map((model) => {
									const inScope = () =>
										scope()?.models === null ||
										scoped().has(modelKey(model.provider, model.id));
									return (
										<SettingsRow
											label={`${model.name || model.id} · ${model.provider}`}
										>
											<Switch
												testID={`settings-catalog-model-${project.id}-${model.id}`}
												checked={inScope()}
												onChange={({ checked }) => {
													const current = scope()?.models;
													if (checked) {
														if (current === null || current === undefined)
															return;
														saveScope(project, [
															...current,
															{
																provider: model.provider,
																modelId: model.id,
																thinkingLevel: null,
															},
														]);
														return;
													}
													// Unchecking leaves inheritance for the
													// catalog minus this model.
													const base =
														current === null || current === undefined
															? models
																	.filter(
																		(candidate) =>
																			modelKey(
																				candidate.provider,
																				candidate.id,
																			) !== modelKey(model.provider, model.id),
																	)
																	.map((candidate) => ({
																		provider: candidate.provider,
																		modelId: candidate.id,
																		thinkingLevel: null,
																	}))
															: current.filter(
																	(entry) =>
																		entry.provider !== model.provider ||
																		entry.modelId !== model.id,
																);
													saveScope(project, base);
												}}
											/>
										</SettingsRow>
									);
								});
							}}
						</SettingsSection>
					);
				})
			}
		</View>
	);
}
