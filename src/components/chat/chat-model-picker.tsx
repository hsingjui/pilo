import { useEffect, useId, useRef, useState } from "react";
import {
	Check,
	RefreshCw,
	Search,
	SlidersHorizontal,
	Star,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { getProjectScopeDraft, piModelsMatch } from "@/lib/pi-model-selection";
import { runtimeErrorMessage, type PiModel } from "@/lib/api/pi-runtime";
import type {
	ModelScopeControls,
	ProjectScopedModel,
} from "@/lib/project-model-scope";
import { cn } from "@/lib/utils";
import {
	Button,
	Checkbox,
	Command,
	CommandInput,
	CommandItem,
	CommandList,
	Input,
	Spinner,
} from "@/ui";

function identity(provider: string, id: string) {
	return JSON.stringify([provider, id]);
}

export function ChatModelPicker({
	models,
	selectedModel,
	loading,
	error,
	disabled,
	onRefresh,
	onChange,
	modelScope,
	canEditScope,
	compact = false,
}: {
	models: readonly PiModel[];
	selectedModel: PiModel | null;
	loading: boolean;
	error: string | null;
	disabled: boolean;
	onRefresh?: () => void;
	onChange?: (model: PiModel | null) => void;
	modelScope?: ModelScopeControls;
	canEditScope: boolean;
	compact?: boolean;
}) {
	const { t } = useTranslation();
	const pickerId = useId();
	const [query, setQuery] = useState("");
	const [activeSelection, setActiveSelection] = useState<{
		listKey: string;
		value: string;
	} | null>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<"all" | "scope">("scope");
	const [draft, setDraft] = useState<{
		initial: ProjectScopedModel[];
		models: ProjectScopedModel[];
	} | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const editing = canEditScope && draft !== null;
	const searchRef = useRef<HTMLInputElement>(null);
	const wasEditingRef = useRef(false);
	useEffect(() => {
		if (editing || wasEditingRef.current) searchRef.current?.focus();
		wasEditingRef.current = editing;
	}, [editing]);
	const scopeReady = Boolean(
		modelScope?.scope && modelScope.catalogReady && !modelScope.error,
	);
	const saving = modelScope?.saving ?? false;
	const defaultScopeModel = modelScope?.scope?.models?.find(
		(entry) => entry.isDefault,
	);
	const defaultScopeValue = defaultScopeModel
		? identity(defaultScopeModel.provider, defaultScopeModel.modelId)
		: null;
	const listLoading = loading || Boolean(modelScope?.loading);
	const listError = saveError ?? modelScope?.error ?? error;
	const listMaxHeight = compact
		? "max-h-[min(14rem,calc(var(--remote-viewport-height,100dvh)*0.35))]"
		: "max-h-[min(16rem,calc(var(--remote-viewport-height,100dvh)*0.35))]";
	const showModels = editing || view === "all" || scopeReady;
	const search = query.trim().toLowerCase();
	const matches = (provider: string, id: string, name = "") =>
		[name, id, provider].some((value) => value.toLowerCase().includes(search));
	const availableModels = modelScope?.availableModels ?? models;
	const visibleModels = (
		editing
			? availableModels
			: view === "all"
				? models
				: (modelScope?.models ?? [])
	).filter((model) => matches(model.provider, model.id, model.name));
	const preferredModel = showModels
		? (visibleModels.find((model) => piModelsMatch(model, selectedModel)) ??
			visibleModels[0])
		: undefined;
	const preferredValue = preferredModel
		? identity(preferredModel.provider, preferredModel.id)
		: "";
	const listKey = JSON.stringify([view, preferredValue]);
	const activeValue =
		activeSelection?.listKey === listKey
			? activeSelection.value
			: preferredValue;
	useEffect(() => {
		if (editing || !activeValue) return;
		const frame = requestAnimationFrame(() => {
			listRef.current
				?.querySelector('[aria-selected="true"]')
				?.scrollIntoView({ block: "nearest" });
		});
		return () => cancelAnimationFrame(frame);
	}, [activeValue, editing]);
	const unavailable =
		editing && draft
			? [...draft.initial, ...draft.models].filter(
					(entry, index, entries) =>
						!availableModels.some(
							(model) =>
								model.provider === entry.provider && model.id === entry.modelId,
						) &&
						entries.findIndex(
							(candidate) =>
								candidate.provider === entry.provider &&
								candidate.modelId === entry.modelId,
						) === index &&
						matches(entry.provider, entry.modelId),
				)
			: [];
	const dirty =
		draft !== null &&
		JSON.stringify(draft.initial) !== JSON.stringify(draft.models);

	const toggle = (provider: string, modelId: string) => {
		setDraft((current) => {
			if (!current) return current;
			const exists = current.models.some(
				(entry) => entry.provider === provider && entry.modelId === modelId,
			);
			const entry = current.initial.find(
				(candidate) =>
					candidate.provider === provider && candidate.modelId === modelId,
			) ?? { provider, modelId, thinkingLevel: null };
			return {
				...current,
				models: exists
					? current.models.filter(
							(candidate) =>
								candidate.provider !== provider ||
								candidate.modelId !== modelId,
						)
					: [...current.models, { ...entry, isDefault: false }],
			};
		});
	};
	const save = async (nextModels: ProjectScopedModel[] | null) => {
		if (!modelScope || saving) return;
		setSaveError(null);
		try {
			await modelScope.save(nextModels);
			setDraft(null);
		} catch (cause) {
			setSaveError(runtimeErrorMessage(cause));
		}
	};
	const toggleDefault = (model: PiModel) => {
		if (!modelScope?.scope || !scopeReady || saving || listLoading || disabled)
			return;
		const value = identity(model.provider, model.id);
		const nextModels = getProjectScopeDraft(
			modelScope.models,
			modelScope.scope,
		);
		for (const entry of nextModels) {
			entry.isDefault =
				identity(entry.provider, entry.modelId) === value &&
				defaultScopeValue !== value;
		}
		void save(nextModels);
	};
	const listPaddingClassName = compact
		? "px-(--pilo-ui-menu-padding) pb-(--pilo-ui-menu-padding)"
		: "px-(--pilo-sheet-padding) pb-(--pilo-sheet-padding)";
	const itemRadiusClassName = compact
		? "rounded-(--pilo-ui-menu-item-radius)"
		: "rounded-(--pilo-sheet-item-radius)";
	const actionClassName = compact
		? undefined
		: "min-h-[max(44px,var(--pilo-sheet-control-height))] rounded-(--pilo-sheet-item-radius)";
	const renderCheckbox = (
		provider: string,
		modelId: string,
		name: string,
		available: boolean,
	) => {
		const checkboxId = `${pickerId}-${encodeURIComponent(identity(provider, modelId))}`;
		return (
			<label
				key={identity(provider, modelId)}
				htmlFor={checkboxId}
				title={`${name || modelId} · ${provider} · ${modelId}${available ? "" : ` · ${t("chat.scopeUnavailable")}`}`}
				className={cn(
					"flex cursor-pointer items-center gap-2 px-2 text-sm hover:bg-hover hover:text-hover-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:disabled]:cursor-default has-[:disabled]:opacity-50",
					itemRadiusClassName,
					compact
						? "min-h-(--pilo-ui-menu-item-height) py-1.5 pointer-coarse:min-h-(--pilo-ui-menu-item-height)"
						: "min-h-[max(44px,var(--pilo-sheet-control-height))] py-2",
				)}
			>
				<Checkbox
					id={checkboxId}
					aria-label={`${name || modelId} · ${provider} · ${modelId}${available ? "" : ` · ${t("chat.scopeUnavailable")}`}`}
					checked={
						draft?.models.some(
							(entry) =>
								entry.provider === provider && entry.modelId === modelId,
						) ?? false
					}
					disabled={saving}
					onCheckedChange={() => toggle(provider, modelId)}
				/>
				{compact ? (
					<>
						<span className="min-w-0 flex-1 truncate">{name || modelId}</span>
						<span className="max-w-32 shrink-0 truncate text-xs text-muted-foreground">
							{provider}
							{!available ? ` · ${t("chat.scopeUnavailable")}` : ""}
						</span>
					</>
				) : (
					<span className="min-w-0 flex-1">
						<span className="block break-words">{name || modelId}</span>
						<span className="block break-all text-xs text-muted-foreground">
							{provider} · {modelId}
							{!available ? ` · ${t("chat.scopeUnavailable")}` : ""}
						</span>
					</span>
				)}
			</label>
		);
	};

	const content = (
		<>
			<div
				role="presentation"
				className={cn(
					"flex items-center gap-2",
					compact ? "p-2" : "flex-wrap px-3 pt-2 pb-2",
				)}
				onKeyDown={(event) => {
					// Toolbar keys must not select cmdk's active model.
					if (event.key !== "Tab" && event.key !== "Escape")
						event.stopPropagation();
				}}
			>
				{editing ? (
					<div className="min-w-0 flex-1">
						<div className="text-sm font-medium">
							{t("chat.editProjectScope")}
						</div>
						<output
							aria-live="polite"
							className="text-xs tabular-nums text-muted-foreground"
						>
							{t("chat.scopeSelectedCount", { count: draft.models.length })}
						</output>
					</div>
				) : (
					<div
						className={cn(
							"flex min-w-0 gap-0.5 p-0.5",
							compact
								? "flex-1 rounded-md bg-muted"
								: "rounded-[calc(var(--pilo-sheet-item-radius)+0.125rem)] bg-muted/60",
						)}
					>
						{(["scope", "all"] as const).map((option) => (
							<Button
								key={option}
								type="button"
								size="sm"
								variant="ghost"
								className={cn(
									"flex-1 px-3 text-sm font-normal text-muted-foreground",
									compact
										? "h-7 rounded-[max(0px,calc(var(--pilo-ui-radius-md)-0.125rem))]"
										: "min-h-[max(44px,var(--pilo-sheet-control-height))] w-20 min-w-0 rounded-(--pilo-sheet-item-radius) whitespace-normal",
									view === option &&
										"bg-popover text-popover-foreground shadow-xs hover:bg-popover hover:text-popover-foreground",
								)}
								aria-pressed={view === option}
								onClick={() => setView(option)}
							>
								{option === "scope"
									? t("chat.scopedModels")
									: t("chat.allModels")}
							</Button>
						))}
					</div>
				)}
				<div className="ms-auto shrink-0">
					<Button
						type="button"
						size="icon"
						variant="ghost"
						className={cn(
							"text-muted-foreground",
							compact
								? "size-8 rounded-lg"
								: "size-[max(44px,var(--pilo-sheet-control-height))] rounded-(--pilo-sheet-item-radius)",
						)}
						disabled={listLoading || saving || !onRefresh}
						aria-label={t("chat.refreshModels")}
						title={t("chat.refreshModels")}
						onClick={() => {
							searchRef.current?.focus();
							onRefresh?.();
							void modelScope?.refresh();
						}}
					>
						<RefreshCw
							className={cn(
								"size-3.5",
								listLoading && "motion-safe:animate-spin",
							)}
							aria-hidden="true"
						/>
					</Button>
				</div>
			</div>
			<div className={compact ? "px-2 pb-2" : "px-3 pb-2"}>
				{editing ? (
					<div className="relative">
						<Search
							className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
							aria-hidden="true"
						/>
						<Input
							ref={searchRef}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							aria-label={t("chat.searchModels")}
							placeholder={t("chat.searchModels")}
							className={cn(
								"ps-10 pe-3",
								compact
									? "h-8 rounded-md text-sm"
									: "min-h-[max(44px,var(--pilo-sheet-control-height))] rounded-(--pilo-sheet-item-radius) text-base md:text-sm",
							)}
						/>
					</div>
				) : (
					<CommandInput
						ref={searchRef}
						value={query}
						onValueChange={setQuery}
						aria-label={t("chat.searchModels")}
						placeholder={t("chat.searchModels")}
						className={cn(
							"text-input-foreground placeholder:text-input-placeholder",
							compact ? "text-sm" : "text-base",
						)}
						wrapperClassName={cn(
							"border border-input-border bg-input-field px-3 hover:border-(--pilo-field-hover-border) has-[:focus-visible]:border-(--pilo-field-focus-border) has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
							compact
								? "h-8 rounded-md"
								: "h-[max(44px,var(--pilo-sheet-control-height))] rounded-(--pilo-sheet-item-radius)",
						)}
					/>
				)}
			</div>
			{editing ? (
				<div className="flex flex-wrap items-center justify-between gap-1 px-2 pb-1">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={actionClassName}
						disabled={saving}
						onClick={() =>
							setDraft((current) => {
								if (!current) return current;
								const additions = visibleModels
									.filter(
										(model) =>
											!current.models.some(
												(entry) =>
													entry.provider === model.provider &&
													entry.modelId === model.id,
											),
									)
									.map((model) => {
										const initial = current.initial.find(
											(entry) =>
												entry.provider === model.provider &&
												entry.modelId === model.id,
										);
										return {
											provider: model.provider,
											modelId: model.id,
											thinkingLevel: initial?.thinkingLevel ?? null,
											isDefault: false,
										};
									});
								return {
									...current,
									models: [...current.models, ...additions],
								};
							})
						}
					>
						{t("chat.selectSearchResults")}
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={actionClassName}
						disabled={saving}
						onClick={() =>
							setDraft((current) =>
								current ? { ...current, models: [] } : current,
							)
						}
					>
						{t("chat.clearScopeSelection")}
					</Button>
				</div>
			) : null}
			{listError ? (
				<p
					role="alert"
					className="mx-3 mb-2 max-h-20 overflow-y-auto rounded-lg bg-destructive/5 p-2 text-xs break-words text-destructive"
				>
					{listError}
				</p>
			) : null}
			{listLoading &&
			(!showModels ||
				(visibleModels.length === 0 && unavailable.length === 0)) ? (
				<output
					aria-live="polite"
					className="flex items-center justify-center gap-2 px-4 py-6 text-xs text-muted-foreground"
				>
					<Spinner className="size-3.5" />
					{t("chat.readingModels")}
				</output>
			) : null}
			{editing ? (
				<fieldset
					aria-label={t("chat.editProjectScope")}
					className={cn(
						"min-w-0",
						listMaxHeight,
						"overflow-y-auto overscroll-contain",
						listPaddingClassName,
					)}
				>
					{visibleModels.map((model) =>
						renderCheckbox(model.provider, model.id, model.name, true),
					)}
					{unavailable.map((entry) =>
						renderCheckbox(entry.provider, entry.modelId, entry.modelId, false),
					)}
					{visibleModels.length === 0 &&
					unavailable.length === 0 &&
					!listLoading &&
					!listError ? (
						<p className="px-3 py-6 text-center text-xs text-muted-foreground">
							{search ? t("chat.noModelMatches") : t("chat.noModels")}
						</p>
					) : null}
				</fieldset>
			) : (
				<CommandList
					ref={listRef}
					aria-label={t("chat.model")}
					containerClassName={listMaxHeight}
					viewportClassName={listMaxHeight}
				>
					<div
						className={cn(
							listPaddingClassName,
							!compact && "space-y-(--pilo-sheet-item-gap)",
						)}
					>
						{showModels
							? visibleModels.map((model) => {
									const selected = piModelsMatch(model, selectedModel);
									const showDefaultToggle =
										view === "scope" && Boolean(modelScope);
									const isDefault =
										identity(model.provider, model.id) === defaultScopeValue;
									return (
										<div
											key={identity(model.provider, model.id)}
											className="group/model-row relative"
										>
											<CommandItem
												value={identity(model.provider, model.id)}
												disabled={disabled || !onChange}
												onSelect={() => onChange?.(model)}
												title={`${model.name || model.id} · ${model.provider} · ${model.id}`}
												aria-label={`${model.name || model.id} · ${model.provider} · ${model.id}${isDefault ? ` · ${t("chat.scopeDefaultModel")}` : ""}${selected ? ` · ${t("chat.currentModel")}` : ""}`}
												className={cn(
													"peer/model-item gap-2",
													itemRadiusClassName,
													compact
														? "min-h-(--pilo-ui-menu-item-height) px-2 py-1.5 pointer-coarse:min-h-(--pilo-ui-menu-item-height)"
														: "min-h-[max(44px,var(--pilo-sheet-model-height))] px-3 py-2",
													showDefaultToggle &&
														(compact ? "pe-10 pointer-coarse:pe-14" : "pe-14"),
												)}
											>
												{compact ? (
													<>
														<span className="min-w-0 flex-1 truncate">
															{model.name || model.id}
														</span>
														<span className="max-w-28 shrink-0 truncate text-xs text-muted-foreground">
															{model.provider}
														</span>
													</>
												) : (
													<span className="min-w-0 flex-1">
														<span className="block leading-snug font-medium wrap-anywhere">
															{model.name || model.id}
														</span>
														<span className="mt-0.5 block text-[0.8125rem] leading-snug text-muted-foreground wrap-anywhere">
															{model.provider}
															{availableModels.some(
																(candidate) =>
																	candidate.provider === model.provider &&
																	candidate.id !== model.id &&
																	(candidate.name || candidate.id) ===
																		(model.name || model.id),
															)
																? ` · ${model.id}`
																: ""}
														</span>
													</span>
												)}
												<span
													className="flex size-4 shrink-0 items-center justify-center"
													aria-hidden="true"
												>
													{selected ? (
														<Check
															className={cn(
																"size-3.5",
																!compact && "text-primary",
															)}
														/>
													) : null}
												</span>
											</CommandItem>
											{showDefaultToggle ? (
												<Button
													type="button"
													variant="ghost"
													size="icon"
													className={cn(
														"absolute end-1 top-1/2 -translate-y-1/2 text-muted-foreground",
														compact
															? "size-7 pointer-coarse:size-11"
															: "size-11",
														!isDefault &&
															"pointer-events-none opacity-0 group-hover/model-row:pointer-events-auto group-hover/model-row:opacity-100 group-focus-within/model-row:pointer-events-auto group-focus-within/model-row:opacity-100 peer-data-[selected=true]/model-item:pointer-events-auto peer-data-[selected=true]/model-item:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
													)}
													disabled={
														disabled || !scopeReady || saving || listLoading
													}
													aria-pressed={isDefault}
													aria-label={t("chat.scopeDefaultModelLabel", {
														model: model.name || model.id,
													})}
													title={
														isDefault
															? t("chat.clearScopeDefault")
															: t("chat.setScopeDefault")
													}
													onClick={(event) => {
														event.stopPropagation();
														searchRef.current?.focus();
														toggleDefault(model);
													}}
													onKeyDown={(event) => {
														if (event.key !== "Tab" && event.key !== "Escape")
															event.stopPropagation();
													}}
												>
													<Star
														className={cn(
															"size-3.5",
															isDefault && "fill-current",
														)}
														aria-hidden="true"
													/>
												</Button>
											) : null}
										</div>
									);
								})
							: null}
						{!listLoading &&
						!listError &&
						(!showModels || visibleModels.length === 0) ? (
							<p className="px-3 py-6 text-center text-xs text-muted-foreground">
								{!showModels
									? t("chat.scopeNotResolved")
									: search
										? t("chat.noModelMatches")
										: view === "scope"
											? t("chat.emptyScope")
											: t("chat.noModels")}
							</p>
						) : null}
					</div>
				</CommandList>
			)}
			{!editing &&
			view === "scope" &&
			modelScope &&
			(compact || canEditScope) ? (
				<div
					role="presentation"
					className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border px-2 py-1.5"
					onKeyDown={(event) => {
						if (event.key !== "Tab" && event.key !== "Escape")
							event.stopPropagation();
					}}
				>
					<span className="text-xs text-muted-foreground">
						{t("chat.scopedModels")}
						{modelScope.scope ? (
							<>
								{" "}
								·{" "}
								{modelScope.scope.models === null
									? t("chat.scopeInherited")
									: t("chat.scopeCustom")}
							</>
						) : null}
					</span>
					{canEditScope ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className={cn("ms-auto", actionClassName)}
							disabled={!scopeReady || saving || listLoading}
							onClick={() => {
								if (!modelScope.scope) return;
								const initial = getProjectScopeDraft(
									modelScope.models,
									modelScope.scope,
								);
								setDraft({ initial, models: [...initial] });
								setSaveError(null);
							}}
						>
							<SlidersHorizontal className="size-3.5" aria-hidden="true" />
							{t("chat.editScope")}
						</Button>
					) : null}
				</div>
			) : null}
			{editing && draft ? (
				<div className="space-y-1.5 border-t border-border p-2">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<span className="text-xs text-muted-foreground">
							{modelScope?.scope?.models === null
								? t("chat.scopeInherited")
								: t("chat.scopeCustom")}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className={cn("ms-auto", actionClassName)}
							disabled={saving || modelScope?.scope?.models === null}
							onClick={() => void save(null)}
						>
							{t("chat.restorePiScope")}
						</Button>
					</div>
					<div className="flex flex-wrap justify-end gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							className={actionClassName}
							disabled={saving}
							onClick={() => {
								setDraft(null);
								setSaveError(null);
							}}
						>
							{t("common.cancel")}
						</Button>
						<Button
							type="button"
							size="sm"
							className={actionClassName}
							disabled={saving || !dirty}
							onClick={() => void save(draft.models)}
						>
							{saving ? <Spinner className="size-3.5" /> : null}
							{t("chat.applyProjectScope")}
						</Button>
					</div>
				</div>
			) : null}
		</>
	);
	return editing ? (
		<div className="font-sans text-sm font-normal">{content}</div>
	) : (
		<Command
			shouldFilter={false}
			value={activeValue}
			onValueChange={(value) => setActiveSelection({ listKey, value })}
			className="h-auto rounded-none bg-transparent font-sans text-sm font-normal text-inherit"
		>
			{content}
		</Command>
	);
}
