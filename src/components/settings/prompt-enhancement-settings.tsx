import { useId } from "react";
import { useTranslation } from "react-i18next";

import type { usePromptEnhancementSettings } from "@/lib/use-prompt-enhancement-settings";
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

type Config = ReturnType<typeof usePromptEnhancementSettings>;

/**
 * Switch and model for one Connection.
 *
 * Mirrors the prompt-suggestion fields: disabled by default, "follow the chat
 * model" unless a Connection picks its own. An unknown saved model stays
 * selectable without a model probe.
 */
export function PromptEnhancementSettingsFields({
	config,
	models,
	connectionName,
}: {
	config: Config;
	models: readonly PiModel[];
	connectionName: string;
}) {
	const { t } = useTranslation();
	const id = useId();
	const settings = config.settings;
	const unique = new Map(
		models.map((model) => [JSON.stringify([model.provider, model.id]), model]),
	);
	if (settings?.model) {
		const selected = settings.model;
		const key = JSON.stringify([selected.provider, selected.id]);
		if (!unique.has(key))
			unique.set(key, { ...selected, name: selected.id, reasoning: false });
	}
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
			value={
				settings?.model
					? JSON.stringify([settings.model.provider, settings.model.id])
					: "follow"
			}
			disabled={!settings || config.saving}
			onValueChange={(value) => {
				const model = unique.get(value);
				void config.save(
					settings?.enabled ?? false,
					model ? { provider: model.provider, id: model.id } : null,
				);
			}}
		>
			<SelectTrigger
				id={`${id}-model`}
				aria-label={t("settings.promptEnhancementModel")}
				className={cn(
					"w-full min-w-0 pointer-coarse:min-h-11",
					SETTINGS_CONTROL_CLASS,
					"sm:w-[320px] max-w-full",
				)}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent className="max-w-[calc(100vw-2rem)]">
				<SelectItem value="follow">
					{t("settings.promptEnhancementFollowModel")}
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
		<div className="min-w-0 divide-y divide-border/60">
			<SettingsRow label={<label htmlFor={id}>{connectionName}</label>}>
				{modelSelect}
				{enabledSwitch}
			</SettingsRow>
			{config.error ? (
				<p
					role="alert"
					className="break-words px-3 py-2 text-xs text-destructive"
				>
					{config.error}
				</p>
			) : null}
		</div>
	);
}
