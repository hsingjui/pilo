import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { useNextPromptSettings } from "@/lib/use-next-prompt-settings";
import type { PiModel } from "@/lib/api/pi-runtime";
import { cn } from "@/lib/utils";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Switch,
} from "@/ui";

import { SettingsRow, SETTINGS_CONTROL_CLASS } from "./compact-layout";

type Config = ReturnType<typeof useNextPromptSettings>;

export function NextPromptSettingsFields({
	config,
	models,
	modelActions,
	unavailable = false,
	connectionName,
}: {
	config: Config;
	models: readonly PiModel[];
	modelActions?: ReactNode;
	unavailable?: boolean;
	connectionName?: string;
}) {
	const { t } = useTranslation();
	const id = useId();
	const settings = config.settings;
	const unique = new Map(
		models.map((model) => [JSON.stringify([model.provider, model.id]), model]),
	);
	const modelValue = settings?.model
		? JSON.stringify([settings.model.provider, settings.model.id])
		: "follow";
	const selectedModelMissing = Boolean(
		settings?.model && !unique.has(modelValue),
	);
	const isSettingsPage = connectionName !== undefined;
	const enabledSwitch = (
		<Switch
			id={id}
			checked={settings?.enabled ?? false}
			disabled={!settings || config.saving}
			onCheckedChange={(enabled) =>
				void config.save(enabled, settings?.model ?? null)
			}
		/>
	);
	const modelSelect = (
		<Select
			value={modelValue}
			disabled={!settings || config.saving}
			onValueChange={(value) => {
				const model = unique.get(value);
				if (value !== "follow" && !model) return;
				void config.save(
					settings?.enabled ?? false,
					model ? { provider: model.provider, id: model.id } : null,
				);
			}}
		>
			<SelectTrigger
				id={`${id}-model`}
				aria-label={isSettingsPage ? t("settings.nextPromptModel") : undefined}
				className={cn(
					"w-full min-w-0 pointer-coarse:min-h-11",
					isSettingsPage && SETTINGS_CONTROL_CLASS,
					isSettingsPage && "sm:w-[320px] max-w-full",
				)}
			>
				<SelectValue>
					{selectedModelMissing ? t("settings.modelUnavailable") : undefined}
				</SelectValue>
			</SelectTrigger>
			<SelectContent className="max-w-[calc(100vw-2rem)]">
				<SelectItem value="follow">
					{t("settings.nextPromptFollowModel")}
				</SelectItem>
				{[...unique.entries()].map(([key, model]) => (
					<SelectItem key={key} value={key}>
						{model.name || model.id} · {model.provider}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
	return (
		<div
			className={
				isSettingsPage
					? "min-w-0 divide-y divide-border/60"
					: "min-w-0 space-y-3"
			}
		>
			{isSettingsPage ? (
				<SettingsRow label={<label htmlFor={id}>{connectionName}</label>}>
					{modelSelect}
					{modelActions}
					{enabledSwitch}
				</SettingsRow>
			) : (
				<>
					<div className="flex items-center justify-between gap-4">
						<label htmlFor={id} className="text-sm font-medium">
							{t("settings.nextPrompt")}
						</label>
						{enabledSwitch}
					</div>
					<p className="text-xs leading-5 text-muted-foreground">
						{t("settings.nextPromptDescription")}
					</p>
					<label htmlFor={`${id}-model`} className="block text-xs font-medium">
						{t("settings.nextPromptModel")}
					</label>
					{modelSelect}
				</>
			)}
			{config.error ? (
				<p
					role="alert"
					className={cn(
						"break-words text-xs text-destructive",
						isSettingsPage && "px-3 py-2",
					)}
				>
					{config.error}
				</p>
			) : null}
			{unavailable ? (
				<output
					className={cn(
						"block text-xs text-muted-foreground",
						isSettingsPage && "px-3 py-2",
					)}
				>
					{t("settings.nextPromptUnavailable")}
				</output>
			) : null}
		</div>
	);
}
