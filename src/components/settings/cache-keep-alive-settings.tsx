import {
	type ReactNode,
	type FocusEvent,
	type KeyboardEvent,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";

import {
	defaultCacheKeepAliveSettings,
	type CacheKeepAliveSettings,
} from "@/lib/cache-keep-alive";
import { isImeComposingKeyboardEvent } from "@/lib/ime";
import type { PiloClient } from "@/lib/api/pilo-client";
import type { PiModel } from "@/lib/api/pi-runtime";
import { useCacheKeepAliveSettings } from "@/lib/use-cache-keep-alive-settings";
import {
	Button,
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
	Input,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Switch,
} from "@/ui";
import { cn } from "@/lib/utils";
import { menuSurfaceStyle } from "@/ui/menu-styles";
import {
	SETTINGS_CONTROL_CLASS,
	SETTINGS_TEXT_BUTTON_CLASS,
	SettingsSection,
} from "./compact-layout";

function ModelSettingsRow({
	settings,
	modelName,
	save,
	onDisabled,
}: {
	settings: CacheKeepAliveSettings;
	modelName: string;
	save: (settings: CacheKeepAliveSettings) => Promise<boolean>;
	onDisabled: () => void;
}) {
	const { t } = useTranslation();
	const [pending, setPending] = useState(0);
	const [disabling, setDisabling] = useState(false);
	const ttlInputRef = useRef<HTMLInputElement>(null);
	const durationInputRef = useRef<HTMLInputElement>(null);
	const [draft, setDraft] = useState<{
		ttl: string;
		duration: string;
	} | null>(null);
	const ttl = draft?.ttl ?? String(settings.cacheTtlSeconds / 60);
	const duration =
		draft?.duration ?? String(settings.idleKeepAliveSeconds / 60);
	const commit = async (enabled = settings.enabled) => {
		const ttlInput = ttlInputRef.current;
		const durationInput = durationInputRef.current;
		if (!ttlInput || !durationInput) return;
		const valid = ttlInput.validity.valid && durationInput.validity.valid;
		if (!valid && enabled) {
			if (!ttlInput.reportValidity()) return;
			durationInput.reportValidity();
			return;
		}
		const next = {
			...settings,
			enabled,
			...(valid
				? {
						cacheTtlSeconds: Math.round(Number(ttl) * 60),
						idleKeepAliveSeconds: Math.round(Number(duration) * 60),
					}
				: {}),
		};
		if (
			pending === 0 &&
			next.enabled === settings.enabled &&
			next.cacheTtlSeconds === settings.cacheTtlSeconds &&
			next.idleKeepAliveSeconds === settings.idleKeepAliveSeconds
		) {
			setDraft(null);
			return;
		}
		setPending((count) => count + 1);
		const saved = await save(next);
		setPending((count) => count - 1);
		if (saved) {
			setDraft((current) =>
				current?.ttl === ttl && current.duration === duration ? null : current,
			);
			if (!enabled) onDisabled();
		}
	};
	const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
		if (disabling) return;
		if (
			event.relatedTarget?.getAttribute("role") === "switch" &&
			event.currentTarget.closest("tr")?.contains(event.relatedTarget)
		)
			return;
		void commit();
	};
	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (isImeComposingKeyboardEvent(event)) return;
		if (event.key === "Enter") {
			event.preventDefault();
			event.currentTarget.blur();
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			setDraft(null);
		}
	};
	return (
		<tr aria-busy={pending > 0}>
			<th
				scope="row"
				aria-label={`${modelName} · ${settings.provider}`}
				className="px-3 py-1 text-start font-normal"
			>
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate font-medium" title={modelName}>
						{modelName}
					</span>
					<span
						className="max-w-24 shrink-0 truncate text-xs text-muted-foreground"
						title={settings.provider}
					>
						{settings.provider}
					</span>
				</div>
			</th>
			<td className="px-3 py-1">
				<Input
					ref={ttlInputRef}
					name="cacheTtlMinutes"
					type="number"
					inputMode="decimal"
					required
					min={10 / 60}
					max={1440}
					step="any"
					value={ttl}
					onChange={(event) => setDraft({ ttl: event.target.value, duration })}
					disabled={disabling}
					onBlur={handleBlur}
					onKeyDown={handleKeyDown}
					aria-label={t("settings.cacheKeepAliveTtl")}
					className={cn(
						SETTINGS_CONTROL_CLASS,
						"w-full tabular-nums shadow-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
					)}
				/>
			</td>
			<td className="px-3 py-1">
				<Input
					ref={durationInputRef}
					name="idleKeepAliveMinutes"
					type="number"
					inputMode="numeric"
					required
					min={1}
					max={1440}
					step={1}
					value={duration}
					onChange={(event) => setDraft({ ttl, duration: event.target.value })}
					disabled={disabling}
					onBlur={handleBlur}
					onKeyDown={handleKeyDown}
					aria-label={t("settings.cacheKeepAliveDuration")}
					className={cn(
						SETTINGS_CONTROL_CLASS,
						"w-full tabular-nums shadow-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
					)}
				/>
			</td>
			<td className="px-3 py-1 text-center">
				<Switch
					aria-label={t("settings.cacheKeepAliveEnabled")}
					checked={settings.enabled}
					disabled={disabling}
					onCheckedChange={(enabled) => {
						setDisabling(true);
						void commit(enabled).then(() => setDisabling(false));
					}}
				/>
			</td>
		</tr>
	);
}

export function CacheKeepAliveSettingsFields({
	client,
	connectionId,
	models,
	modelActions,
	initialModel,
	sessionKey,
	connectionName,
}: {
	client: PiloClient;
	connectionId: string;
	models: readonly PiModel[];
	modelActions?: ReactNode;
	initialModel?: PiModel | null;
	sessionKey?: string;
	connectionName?: string;
}) {
	const { t } = useTranslation();
	const config = useCacheKeepAliveSettings(client, connectionId, sessionKey);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [adding, setAdding] = useState(false);
	const addButtonRef = useRef<HTMLButtonElement>(null);
	const unique = new Map(
		models.map((model) => [
			JSON.stringify([model.provider, model.id]),
			{ provider: model.provider, id: model.id, name: model.name },
		]),
	);
	if (initialModel)
		unique.set(
			JSON.stringify([initialModel.provider, initialModel.id]),
			initialModel,
		);
	for (const settings of config.settings) {
		const key = JSON.stringify([settings.provider, settings.modelId]);
		if (!unique.has(key))
			unique.set(key, {
				provider: settings.provider,
				id: settings.modelId,
				name: settings.modelId,
			});
	}
	const enabledSettings = config.settings.filter((row) => row.enabled);
	const configured = new Set(
		enabledSettings.map((row) => JSON.stringify([row.provider, row.modelId])),
	);
	const available = [...unique].filter(
		([key, model]) =>
			!configured.has(key) &&
			models.some(
				(candidate) =>
					candidate.provider === model.provider && candidate.id === model.id,
			),
	);
	const unsupported =
		config.unavailable ||
		config.status?.ready === false ||
		config.status?.reason === "unsupported_request";
	return (
		<SettingsSection
			title={connectionName ?? t("settings.cacheKeepAliveModels")}
			headerRight={modelActions}
			actions={
				<Popover modal open={pickerOpen} onOpenChange={setPickerOpen}>
					<PopoverTrigger asChild>
						<Button
							ref={addButtonRef}
							type="button"
							variant="ghost"
							size="sm"
							className={cn(
								SETTINGS_TEXT_BUTTON_CLASS,
								"w-auto text-muted-foreground hover:text-foreground data-[state=open]:bg-hover data-[state=open]:text-foreground [@media(pointer:coarse)]:min-h-11",
							)}
							disabled={config.loading || adding}
						>
							<Plus className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
							{t("settings.cacheKeepAliveAddModel")}
						</Button>
					</PopoverTrigger>
					<PopoverContent
						align="end"
						className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border-0 bg-background p-0 text-foreground shadow-none"
						style={menuSurfaceStyle}
					>
						<Command className="h-auto rounded-xl bg-background text-foreground">
							<CommandInput
								aria-label={t("chat.searchModels")}
								placeholder={t("chat.searchModels")}
								className="text-input-foreground placeholder:text-input-placeholder"
								wrapperClassName="m-2 h-8 shrink-0 rounded-md border border-input-border bg-input-field px-2.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring [@media(pointer:coarse)]:h-11 [&>svg]:me-2 [&>svg]:size-3.5 [&>svg]:text-muted-foreground [&>svg]:opacity-100 [&>svg]:stroke-[1.5]"
							/>
							<CommandList
								aria-label={t("settings.cacheKeepAliveModel")}
								className="space-y-0.5 p-1 pt-0"
								containerClassName="max-h-none"
								viewportClassName="max-h-[min(18rem,calc(var(--radix-popover-content-available-height)-4.5rem))] overscroll-contain"
							>
								<CommandEmpty className="px-3 py-6 text-center text-xs text-muted-foreground">
									{t("chat.noModelMatches")}
								</CommandEmpty>
								{available.map(([key, model]) => (
									<CommandItem
										key={key}
										value={key}
										keywords={[model.name, model.id, model.provider]}
										disabled={adding}
										className="min-h-8 gap-3 rounded-lg px-3 py-1.5 [@media(pointer:coarse)]:min-h-11"
										title={`${model.name || model.id} · ${model.provider} · ${model.id}`}
										onSelect={() => {
											if (adding) return;
											setAdding(true);
											const settings =
												config.settings.find(
													(row) =>
														row.provider === model.provider &&
														row.modelId === model.id,
												) ??
												defaultCacheKeepAliveSettings(
													connectionId,
													model.provider,
													model.id,
												);
											void config
												.save({ ...settings, enabled: true })
												.then((saved) => {
													setAdding(false);
													if (saved) setPickerOpen(false);
												});
										}}
									>
										<span className="min-w-0 flex-1 truncate">
											{model.name || model.id}
										</span>
										<span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
											{model.provider}
										</span>
									</CommandItem>
								))}
							</CommandList>
						</Command>
					</PopoverContent>
				</Popover>
			}
		>
			{config.loading ? (
				<p className="px-3 py-3 text-xs text-muted-foreground">
					{t("common.loading")}
				</p>
			) : (
				<div className="overflow-x-auto">
					<table
						className="w-full min-w-[560px] table-fixed whitespace-nowrap text-sm"
						aria-label={t("settings.cacheKeepAliveModels")}
					>
						<colgroup>
							<col />
							<col className="w-28" />
							<col className="w-32" />
							<col className="w-20" />
						</colgroup>
						<thead className="border-b border-border/60 text-xs text-muted-foreground">
							<tr>
								<th scope="col" className="px-3 py-2 text-start font-medium">
									{t("settings.cacheKeepAliveModel")}
								</th>
								<th scope="col" className="px-3 py-2 text-start font-medium">
									{t("settings.cacheKeepAliveTtlLabel")} (
									{t("settings.cacheKeepAliveMinutes")})
								</th>
								<th scope="col" className="px-3 py-2 text-start font-medium">
									{t("settings.cacheKeepAliveDurationLabel")} (
									{t("settings.cacheKeepAliveMinutes")})
								</th>
								<th scope="col" className="px-3 py-2 text-center font-medium">
									{t("settings.cacheKeepAliveEnabledLabel")}
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border/60">
							{enabledSettings.map((settings) => {
								const key = JSON.stringify([
									settings.provider,
									settings.modelId,
								]);
								const model = unique.get(key);
								return (
									<ModelSettingsRow
										key={key}
										settings={settings}
										modelName={model?.name || settings.modelId}
										save={config.save}
										onDisabled={() =>
											requestAnimationFrame(() => addButtonRef.current?.focus())
										}
									/>
								);
							})}
							{enabledSettings.length === 0 && !config.error ? (
								<tr>
									<td
										colSpan={4}
										className="px-3 py-3 text-xs text-muted-foreground"
									>
										{t(
											available.length
												? "settings.cacheKeepAliveEmpty"
												: "settings.cacheKeepAliveNoModels",
										)}
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
				</div>
			)}
			{unsupported ? (
				<output className="block px-3 py-2 text-xs text-muted-foreground">
					{t("settings.cacheKeepAliveUnsupported")}
				</output>
			) : null}
			{config.error ? (
				<p
					role="alert"
					className="break-words px-3 py-2 text-xs text-destructive"
				>
					{config.error}
				</p>
			) : null}
		</SettingsSection>
	);
}
