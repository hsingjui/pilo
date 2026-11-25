import { effect, Scroll, signal, Text, token, untracked, View } from "nsh";

import type { PiModel } from "@shared/api/pi-runtime-types";
import {
	addProjectScopeDraftModels,
	getProjectScopeDraft,
	getUnavailableProjectScopeDraftModels,
	isProjectScopeDraftDirty,
	piModelsMatch,
	projectScopeDraftHasModel,
	toggleProjectScopeDefaultModel,
	toggleProjectScopeDraftModel,
	type ProjectScopeDraft,
} from "@shared/pi-model-selection";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@shared/project-model-scope";

import { t } from "../shell/i18n";
import { Button } from "../ui/button";
import { classNames } from "../ui/class-names";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { MenuCheck } from "../ui/menu-check";
import { MenuItem } from "../ui/menu-item";
import { scrollbarLook } from "../ui/scrollbar";
import { Spinner } from "../ui/spinner";
import { styleVar } from "../ui/theme-style";

export interface ComposerModelPickerProps {
	/** Every model of the project's catalog. */
	models: () => readonly PiModel[];
	/** The Scope's effective models, in cycle order. */
	scopeModels: () => readonly PiModel[];
	/** The project's saved Scope; `null` until it is read. */
	scope: () => ProjectModelScope | null;
	/** The catalog resolved every model's Scope membership. */
	scopeReady: () => boolean;
	selected: () => PiModel | null;
	/** The catalog is loading or refreshing. */
	loading: () => boolean;
	/** The last catalog refresh's failure. */
	error: () => string | null;
	saving: () => boolean;
	disabled: () => boolean;
	onSelect: (model: PiModel) => void;
	onRefresh?: () => void;
	/** Saves the project Scope (`null` inherits Pi's); without it the Scope is read-only. */
	onSaveScope?: (models: ProjectScopedModel[] | null) => Promise<void>;
}

function identity(provider: string, id: string) {
	return JSON.stringify([provider, id]);
}

const ROW_CLASS = "px-2";

/**
 * The run-config menu's model panel, as the React composer's compact
 * `ChatModelPicker`: Scope / all models, a search, refresh, the Scope's
 * default star and the Scope editor.
 */
export function ComposerModelPicker(props: ComposerModelPickerProps) {
	const query = signal("");
	const view = signal<"scope" | "all">("scope");
	const draft = signal<ProjectScopeDraft | null>(null);
	const saveError = signal<string | null>(null);

	const editing = () => draft() !== null;
	const search = () => query().trim().toLowerCase();
	const matches = (provider: string, id: string, name = "") =>
		[name, id, provider].some((value) =>
			value.toLowerCase().includes(search()),
		);
	const scopeReady = () => props.scope() !== null && props.scopeReady();
	// A catalog without Scope metadata, such as the connection's models shown
	// for a project not probed yet, still lists its models under All.
	effect(() => {
		if (!props.loading() && !scopeReady() && props.models().length > 0) {
			untracked(() => view.set("all"));
		}
	});
	const showModels = () => editing() || view() === "all" || scopeReady();
	const visibleModels = () =>
		(editing() || view() === "all"
			? props.models()
			: props.scopeModels()
		).filter((model) => matches(model.provider, model.id, model.name));
	const defaultValue = () => {
		const entry = props.scope()?.models?.find((model) => model.isDefault);
		return entry ? identity(entry.provider, entry.modelId) : null;
	};
	const listError = () => saveError() ?? props.error();
	const busy = () => props.loading() || props.saving();
	const unavailable = () => {
		const current = draft();
		return current
			? getUnavailableProjectScopeDraftModels(current, props.models()).filter(
					(entry) => matches(entry.provider, entry.modelId),
				)
			: [];
	};
	const dirty = () => isProjectScopeDraftDirty(draft());

	const save = async (models: ProjectScopedModel[] | null) => {
		if (!props.onSaveScope || props.saving()) return;
		saveError.set(null);
		try {
			await props.onSaveScope(models);
			draft.set(null);
		} catch (error) {
			saveError.set(error instanceof Error ? error.message : String(error));
		}
	};
	const toggleDefault = (model: PiModel) => {
		const scope = props.scope();
		if (!scope || !scopeReady() || busy() || props.disabled()) return;
		void save(
			toggleProjectScopeDefaultModel(props.scopeModels(), scope, model),
		);
	};
	const startEditing = () => {
		const scope = props.scope();
		if (!scope) return;
		const initial = getProjectScopeDraft(props.scopeModels(), scope);
		draft.set({ initial, models: [...initial] });
		saveError.set(null);
	};
	const toggle = (provider: string, modelId: string) => {
		const current = draft();
		if (current)
			draft.set(toggleProjectScopeDraftModel(current, provider, modelId));
	};
	const selectSearchResults = () => {
		const current = draft();
		if (current)
			draft.set(addProjectScopeDraftModels(current, visibleModels()));
	};

	const refreshButton = () => (
		<Button
			testID="run-config-refresh"
			variant="ghost"
			size="icon"
			class="size-8 shrink-0 rounded-lg"
			disabled={props.saving() || !props.onRefresh}
			accessibilityLabel={t("chat.refreshModels")}
			onPress={() => {
				if (props.loading()) return;
				props.onRefresh?.();
			}}
		>
			<Icon
				name="RefreshCw"
				size={14}
				color={token("muted-foreground")}
				class={props.loading() ? "animate-spin" : undefined}
			/>
		</Button>
	);

	const searchField = () => (
		<View class="px-1 pb-2">
			<View class="relative justify-center">
				<Input
					testID="run-config-model-search"
					autoFocus
					value={query()}
					placeholder={t("chat.searchModels")}
					accessibilityLabel={t("chat.searchModels")}
					size="sm"
					class="pl-8"
					onChange={(event) => query.set(event.value)}
				/>
				<View class="pointer-events-none absolute inset-y-0 left-2.5 justify-center">
					<Icon name="Search" size={14} color={token("muted-foreground")} />
				</View>
			</View>
		</View>
	);

	const errorText = () =>
		listError() ? (
			<View class="mx-1 mb-2 rounded-lg bg-destructive/5 p-2">
				<Text class="font-sans text-xs text-destructive">{listError}</Text>
			</View>
		) : null;

	const loadingText = () =>
		props.loading() &&
		(!showModels() ||
			(visibleModels().length === 0 && unavailable().length === 0)) ? (
			<View class="flex-row items-center justify-center gap-2 px-4 py-6">
				<Spinner size={14} color={token("muted-foreground")} />
				<Text class="font-sans text-xs text-muted-foreground">
					{() => t("chat.readingModels")}
				</Text>
			</View>
		) : null;

	const emptyText = (message: string) => (
		<View class="px-3 py-6">
			<Text class="text-center font-sans text-xs text-muted-foreground">
				{message}
			</Text>
		</View>
	);

	const modelRow = (model: PiModel) => {
		const selected = () => piModelsMatch(model, props.selected());
		const isDefault = () =>
			identity(model.provider, model.id) === defaultValue();
		const showStar = view() === "scope" && props.onSaveScope !== undefined;
		const name = model.name || model.id;
		return (
			<View class="group relative flex-row items-center">
				<MenuItem
					testID={`run-config-model:${model.provider}:${model.id}`}
					role="menuitemradio"
					checked={selected()}
					disabled={props.disabled()}
					indicatorClass="hidden"
					class={classNames("min-w-0 flex-1", ROW_CLASS, showStar && "pr-9")}
					accessibilityLabel={`${name} · ${model.provider} · ${model.id}${isDefault() ? ` · ${t("chat.scopeDefaultModel")}` : ""}${selected() ? ` · ${t("chat.currentModel")}` : ""}`}
					onSelect={() => props.onSelect(model)}
				>
					<Text class="min-w-0 flex-1 truncate font-sans text-sm">{name}</Text>
					<Text class="max-w-28 shrink-0 truncate font-sans text-xs text-muted-foreground">
						{model.provider}
					</Text>
					<MenuCheck checked={selected} />
				</MenuItem>
				{showStar ? (
					<Button
						testID={`run-config-default:${model.provider}:${model.id}`}
						variant="ghost"
						size="icon"
						class={classNames(
							"absolute right-1 size-7",
							!isDefault() &&
								"opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
						)}
						disabled={
							props.disabled() || !scopeReady() || props.saving() || busy()
						}
						accessibilityLabel={t("chat.scopeDefaultModelLabel", {
							model: name,
						})}
						onPress={() => toggleDefault(model)}
					>
						<Icon
							name="Star"
							size={14}
							fill={isDefault()}
							color={token("muted-foreground")}
						/>
					</Button>
				) : null}
			</View>
		);
	};

	const draftRow = (
		provider: string,
		modelId: string,
		name: string,
		available: boolean,
	) => {
		const checked = () => projectScopeDraftHasModel(draft(), provider, modelId);
		const detail = `${provider}${available ? "" : ` · ${t("chat.scopeUnavailable")}`}`;
		return (
			<MenuItem
				testID={`run-config-scope:${provider}:${modelId}`}
				role="menuitemcheckbox"
				checked={checked()}
				closeOnSelect={false}
				disabled={props.saving()}
				indicatorClass="hidden"
				class={ROW_CLASS}
				accessibilityLabel={`${name || modelId} · ${provider} · ${modelId}${available ? "" : ` · ${t("chat.scopeUnavailable")}`}`}
				onSelect={() => toggle(provider, modelId)}
			>
				<View
					class={classNames(
						"size-4 shrink-0 items-center justify-center rounded-[4px] border",
						checked() ? "border-primary bg-primary" : "border-input-border",
					)}
					style={{ boxShadow: styleVar("pilo-shadow-xs") }}
				>
					{() =>
						checked() ? (
							<Icon
								name="Check"
								size={12}
								color={token("primary-foreground")}
							/>
						) : null
					}
				</View>
				<Text class="min-w-0 flex-1 truncate font-sans text-sm">
					{name || modelId}
				</Text>
				<Text class="max-w-32 shrink-0 truncate font-sans text-xs text-muted-foreground">
					{detail}
				</Text>
			</MenuItem>
		);
	};

	const browsing = () => (
		<>
			<View class="flex-row items-center gap-2 p-1 pb-2">
				<View class="min-w-0 flex-1 flex-row gap-0.5 rounded-(--pilo-radius-md) bg-muted p-0.5">
					{(["scope", "all"] as const).map((option) => (
						<Button
							testID={`run-config-view:${option}`}
							variant="ghost"
							size="sm"
							class={classNames(
								"h-7 min-w-0 flex-1 rounded-[max(0px,calc(var(--pilo-radius-md)-0.125rem))] px-3",
								view() === option && "bg-popover hover:bg-popover",
							)}
							style={{
								boxShadow:
									view() === option ? styleVar("pilo-shadow-xs") : undefined,
							}}
							selected={view() === option}
							onPress={() => view.set(option)}
						>
							<Text
								class={classNames(
									"font-sans text-sm font-normal",
									view() === option
										? "text-popover-foreground"
										: "text-muted-foreground",
								)}
							>
								{() =>
									option === "scope"
										? t("chat.scopedModels")
										: t("chat.allModels")
								}
							</Text>
						</Button>
					))}
				</View>
				{refreshButton()}
			</View>
			{searchField()}
			{errorText}
			{loadingText}
			<Scroll
				class="max-h-56 min-h-0"
				contentClass="gap-1 pb-1"
				bounces={false}
				scrollbar={{ vertical: scrollbarLook() }}
			>
				{() => (showModels() ? visibleModels().map(modelRow) : null)}
				{() =>
					!props.loading() &&
					!listError() &&
					(!showModels() || visibleModels().length === 0)
						? emptyText(
								!showModels()
									? t("chat.scopeNotResolved")
									: search()
										? t("chat.noModelMatches")
										: view() === "scope"
											? t("chat.emptyScope")
											: t("chat.noModels"),
							)
						: null
				}
			</Scroll>
			{() =>
				view() === "scope" ? (
					<View class="flex-row flex-wrap items-center gap-x-2 gap-y-1 border-t border-border px-2 pt-1.5">
						<Text class="min-w-0 flex-1 truncate font-sans text-xs text-muted-foreground">
							{() => {
								const scope = props.scope();
								if (!scope) return t("chat.scopedModels");
								return `${t("chat.scopedModels")} · ${scope.models === null ? t("chat.scopeInherited") : t("chat.scopeCustom")}`;
							}}
						</Text>
						{props.onSaveScope ? (
							<Button
								testID="run-config-edit-scope"
								variant="ghost"
								size="sm"
								disabled={!scopeReady() || busy()}
								onPress={startEditing}
							>
								<Icon name="SlidersHorizontal" size={14} />
								<Text class="font-sans text-xs">
									{() => t("chat.editScope")}
								</Text>
							</Button>
						) : null}
					</View>
				) : null
			}
		</>
	);

	const editor = () => (
		<>
			<View class="flex-row items-center gap-2 p-1 pb-2">
				<View class="min-w-0 flex-1">
					<Text class="font-sans text-sm font-medium">
						{() => t("chat.editProjectScope")}
					</Text>
					<Text class="font-sans text-xs text-muted-foreground tabular-nums">
						{() =>
							t("chat.scopeSelectedCount", {
								count: draft()?.models.length ?? 0,
							})
						}
					</Text>
				</View>
				{refreshButton()}
			</View>
			{searchField()}
			<View class="flex-row flex-wrap items-center justify-between gap-1 px-1 pb-1">
				<Button
					variant="ghost"
					size="sm"
					disabled={props.saving()}
					onPress={selectSearchResults}
				>
					<Text class="font-sans text-xs">
						{() => t("chat.selectSearchResults")}
					</Text>
				</Button>
				<Button
					variant="ghost"
					size="sm"
					disabled={props.saving()}
					onPress={() => {
						const current = draft();
						if (current) draft.set({ ...current, models: [] });
					}}
				>
					<Text class="font-sans text-xs">
						{() => t("chat.clearScopeSelection")}
					</Text>
				</Button>
			</View>
			{errorText}
			{loadingText}
			<Scroll
				class="max-h-56 min-h-0"
				contentClass="gap-1 pb-1"
				bounces={false}
				scrollbar={{ vertical: scrollbarLook() }}
			>
				{() =>
					visibleModels().map((model) =>
						draftRow(model.provider, model.id, model.name, true),
					)
				}
				{() =>
					unavailable().map((entry) =>
						draftRow(entry.provider, entry.modelId, entry.modelId, false),
					)
				}
				{() =>
					visibleModels().length === 0 &&
					unavailable().length === 0 &&
					!props.loading() &&
					!listError()
						? emptyText(
								search() ? t("chat.noModelMatches") : t("chat.noModels"),
							)
						: null
				}
			</Scroll>
			<View class="gap-1.5 border-t border-border px-1 pt-2">
				<View class="flex-row flex-wrap items-center justify-between gap-2">
					<Text class="font-sans text-xs text-muted-foreground">
						{() =>
							props.scope()?.models === null
								? t("chat.scopeInherited")
								: t("chat.scopeCustom")
						}
					</Text>
					<Button
						variant="ghost"
						size="sm"
						disabled={props.saving() || props.scope()?.models === null}
						onPress={() => void save(null)}
					>
						<Text class="font-sans text-xs">
							{() => t("chat.restorePiScope")}
						</Text>
					</Button>
				</View>
				<View class="flex-row flex-wrap justify-end gap-2">
					<Button
						variant="outline"
						size="sm"
						disabled={props.saving()}
						onPress={() => {
							draft.set(null);
							saveError.set(null);
						}}
					>
						<Text class="font-sans text-xs">{() => t("common.cancel")}</Text>
					</Button>
					<Button
						testID="run-config-apply-scope"
						size="sm"
						disabled={props.saving() || !dirty()}
						onPress={() => {
							const current = draft();
							if (current) void save(current.models);
						}}
					>
						{() =>
							props.saving() ? (
								<Spinner size={14} color={token("primary-foreground")} />
							) : null
						}
						<Text class="font-sans text-xs text-primary-foreground">
							{() => t("chat.applyProjectScope")}
						</Text>
					</Button>
				</View>
			</View>
		</>
	);

	return (
		<View class="w-68 max-w-full font-sans">
			{() => (editing() ? editor() : browsing())}
		</View>
	);
}
