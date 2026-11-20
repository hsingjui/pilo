import { type Accessor, cleanup, effect, signal, Text, View } from "nsh";

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
import {
	modelKey,
	settingsErrorMessage,
	uniqueModels,
} from "./connection-settings";
import { SettingsRow, SettingsSection, SettingsStatus } from "./layout";
import type { SettingsClient } from "./settings-dialog";

type CatalogRow = {
	provider: string;
	id: string;
	name: string;
	inCatalog: boolean;
};

/**
 * Model catalog per project: the cached Pi catalog with a refresh, and the
 * project's model scope — a `null` scope inherits every model Pi reports.
 * Mirrors the shared `ConnectionModelCatalog` behaviors (refresh disabled
 * while loading, a destructive error line) and the chat picker's scope
 * editor (scoped entries missing from the catalog stay listed, marked
 * unavailable; saves and switches disable while one save is in flight).
 */
export function ModelCatalogPane(props: {
	state: Accessor<AppState>;
	client: SettingsClient;
}) {
	const catalogs = signal<Record<string, ProjectPiModels | null>>({});
	const scopes = signal<Record<string, ProjectModelScope>>({});
	const refreshing = signal<Record<string, boolean>>({});
	const saving = signal<Record<string, boolean>>({});
	const errors = signal<Record<string, string | undefined>>({});
	const loaded = new Set<string>();
	let alive = true;
	cleanup(() => {
		alive = false;
	});

	const setError = (projectId: string, error: string | null) =>
		errors.set({ ...errors(), [projectId]: error ?? undefined });
	const ensure = (projectId: string) => {
		if (loaded.has(projectId)) return;
		loaded.add(projectId);
		Promise.all([
			props.client.loadModels(projectId),
			props.client.loadModelScope(projectId),
		])
			.then(([catalog, scope]) => {
				if (!alive) return;
				catalogs.set({ ...catalogs(), [projectId]: catalog });
				scopes.set({ ...scopes(), [projectId]: scope });
			})
			.catch((error: unknown) => {
				if (alive) setError(projectId, settingsErrorMessage(error));
			});
	};
	const mergeScope = (scope: ProjectModelScope) => {
		const current = scopes()[scope.projectId];
		if (current && current.updatedAtMs > scope.updatedAtMs) return;
		scopes.set({ ...scopes(), [scope.projectId]: scope });
	};

	effect(() => {
		let stop: (() => void) | undefined;
		let disposed = false;
		void props.client
			.connectEvents({
				onMessage(message) {
					if (message.type !== "events") return;
					for (const event of message.events)
						if (event.type === "project_model_scope_changed")
							mergeScope(event.scope);
				},
				onStatus() {},
			})
			.then((unlisten) => {
				if (disposed) unlisten();
				else stop = unlisten;
			})
			.catch(() => undefined);
		return () => {
			disposed = true;
			stop?.();
		};
	});

	const saveScope = (project: Project, models: ProjectScopedModel[] | null) => {
		if (saving()[project.id]) return;
		saving.set({ ...saving(), [project.id]: true });
		props.client
			.saveModelScope(project.id, models)
			.then((scope) => {
				if (!alive) return;
				mergeScope(scope);
				setError(project.id, null);
			})
			.catch((error: unknown) => {
				if (alive) setError(project.id, settingsErrorMessage(error));
			})
			.finally(() => {
				if (alive) saving.set({ ...saving(), [project.id]: false });
			});
	};
	const refresh = (project: Project) => {
		if (refreshing()[project.id]) return;
		refreshing.set({ ...refreshing(), [project.id]: true });
		props.client
			.loadConnectionModels(project.connection.id)
			.then((models) => {
				const previous = catalogs()[project.id];
				return props.client.saveModels({
					projectId: project.id,
					models: uniqueModels(models),
					commands: previous?.commands ?? null,
					defaultModel: previous?.defaultModel ?? null,
					defaultThinkingLevel: previous?.defaultThinkingLevel ?? null,
					refreshedAtMs: Date.now(),
				});
			})
			.then((catalog) => {
				if (alive) {
					catalogs.set({ ...catalogs(), [project.id]: catalog });
					setError(project.id, null);
				}
			})
			.catch((error: unknown) => {
				if (alive)
					setError(
						project.id,
						`${t("settings.refreshModelsFailed")} ${settingsErrorMessage(error)}`,
					);
			})
			.finally(() => {
				if (alive) refreshing.set({ ...refreshing(), [project.id]: false });
			});
	};
	return (
		<View class="gap-3">
			{() =>
				props.state().projects.flatMap((project) => {
					ensure(project.id);
					const catalog = () => catalogs()[project.id];
					const scope = () => scopes()[project.id];
					const scoped = () =>
						new Set(
							(scope()?.models ?? []).map((entry) =>
								modelKey(entry.provider, entry.modelId),
							),
						);
					const catalogRows = (): CatalogRow[] => {
						const models = uniqueModels(catalog()?.models ?? []);
						const rows: CatalogRow[] = models.map((model) => ({
							provider: model.provider,
							id: model.id,
							name: model.name || model.id,
							inCatalog: true,
						}));
						// A scoped entry the catalog no longer reports stays listed,
						// marked unavailable, as the chat picker's scope editor.
						for (const entry of scope()?.models ?? [])
							if (
								!rows.some(
									(row) =>
										row.provider === entry.provider && row.id === entry.modelId,
								)
							)
								rows.push({
									provider: entry.provider,
									id: entry.modelId,
									name: entry.modelId,
									inCatalog: false,
								});
						return rows;
					};
					const section = (
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
											disabled={saving()[project.id]}
											onPress={() => saveScope(project, null)}
										>
											<Text>{t("settings.modelCatalogInherit")}</Text>
										</Button>
									)}
									<Button
										testID={`settings-catalog-refresh-${project.id}`}
										variant="ghost"
										size="icon"
										class="size-8"
										disabled={refreshing()[project.id]}
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
								const rows = catalogRows();
								if (rows.length === 0)
									return (
										<View class="px-3 py-4">
											<Text class="text-sm text-muted-foreground">
												{t("settings.modelCatalogEmpty")}
											</Text>
										</View>
									);
								return rows.map((row) => {
									const inScope = () =>
										scope()?.models === null ||
										scoped().has(modelKey(row.provider, row.id));
									return (
										<SettingsRow
											label={`${row.name} · ${row.provider}${row.inCatalog ? "" : ` · ${t("chat.scopeUnavailable")}`}`}
										>
											<Switch
												testID={`settings-catalog-model-${project.id}-${row.id}`}
												checked={inScope()}
												disabled={saving()[project.id]}
												onChange={({ checked }) => {
													const current = scope()?.models;
													if (checked) {
														if (current === null || current === undefined)
															return;
														saveScope(project, [
															...current,
															{
																provider: row.provider,
																modelId: row.id,
																thinkingLevel: null,
															},
														]);
														return;
													}
													// Unchecking leaves inheritance for the
													// catalog minus this model.
													const base =
														current === null || current === undefined
															? rows
																	.filter(
																		(candidate) =>
																			candidate.inCatalog &&
																			modelKey(
																				candidate.provider,
																				candidate.id,
																			) !== modelKey(row.provider, row.id),
																	)
																	.map((candidate) => ({
																		provider: candidate.provider,
																		modelId: candidate.id,
																		thinkingLevel: null,
																	}))
															: current.filter(
																	(entry) =>
																		entry.provider !== row.provider ||
																		entry.modelId !== row.id,
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
					const error = errors()[project.id];
					return error
						? [
								section,
								<View class="px-3 py-2">
									<Text class="text-xs text-destructive">{error}</Text>
								</View>,
							]
						: [section];
				})
			}
		</View>
	);
}
