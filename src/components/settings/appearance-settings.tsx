import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ExternalLink, Trash2 } from "lucide-react";

import { validateWebThemeTokens } from "@/lib/theme-web";
import { CUSTOM_CSS_PLACEHOLDER } from "@/lib/theme-custom";
import { compatibleThemeUpdate } from "@/lib/theme-compat";
import { useTheme, type Theme, type ThemeFamily } from "@/lib/theme-provider";
import { REPOSITORY_URL } from "@/lib/use-release-notes";
import { cn } from "@/lib/utils";
import {
	Button,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Textarea,
} from "@/ui";
import {
	SETTINGS_CONTAINER_CLASS,
	SETTINGS_CONTROL_CLASS,
	SettingsRow,
	SettingsSection,
} from "./compact-layout";
import { SettingsConfirmDialog } from "./settings-confirm-dialog";
import { ThemeConversionNotice } from "./theme-conversion-notice";
import {
	ThemeTokenEditor,
	editableThemeTokens,
	themeTokensKey,
} from "./theme-token-editor";

const THEME_MODES = [
	{ value: "light", label: "settings.light" },
	{ value: "dark", label: "settings.dark" },
	{ value: "system", label: "settings.system" },
] as const satisfies readonly { value: Theme; label: string }[];

const THEME_FAMILIES = [
	{ value: "lody", label: "settings.themeFamilyLody" },
	{ value: "claude", label: "settings.themeFamilyClaude" },
] as const satisfies readonly { value: ThemeFamily; label: string }[];

export function AppearanceSettings() {
	const { t } = useTranslation();
	const {
		theme,
		themeFamily,
		themeCustomTokens = {},
		themeCustomConversion,
		themeCustomCss,
		supportsThemeTokens,
		themeCustomName,
		savedCustomThemes,
		updateThemeSettings,
	} = useTheme();
	const updateSettings: typeof updateThemeSettings = (update) =>
		updateThemeSettings(compatibleThemeUpdate(update, supportsThemeTokens));
	const activeSavedTheme = savedCustomThemes.find(
		(item) =>
			item.name === themeCustomName &&
			(supportsThemeTokens
				? themeTokensKey(item.tokens ?? {}) ===
					themeTokensKey(themeCustomTokens)
				: item.css === themeCustomCss),
	);
	const sourceName = activeSavedTheme?.name ?? "";
	const [draftTokens, setDraftTokens] = useState(() =>
		editableThemeTokens(themeCustomTokens),
	);
	const [draftCss, setDraftCss] = useState(themeCustomCss);
	const draftKey = supportsThemeTokens ? themeTokensKey(draftTokens) : draftCss;
	const currentKey = supportsThemeTokens
		? themeTokensKey(themeCustomTokens)
		: themeCustomCss;
	const validation = validateWebThemeTokens(draftTokens);
	const [draftName, setDraftName] = useState(sourceName);
	const [draftSource, setDraftSource] = useState({
		key: currentKey,
		name: sourceName,
		tokens: supportsThemeTokens,
	});
	if (
		draftSource.key !== currentKey ||
		draftSource.name !== sourceName ||
		draftSource.tokens !== supportsThemeTokens
	) {
		// Follow remote edits only while the local draft is unchanged.
		if (
			draftSource.tokens !== supportsThemeTokens ||
			(draftKey === draftSource.key && draftName === draftSource.name)
		) {
			setDraftTokens(editableThemeTokens(themeCustomTokens));
			setDraftCss(themeCustomCss);
			setDraftName(sourceName);
		}
		setDraftSource({
			key: currentKey,
			name: sourceName,
			tokens: supportsThemeTokens,
		});
	}
	const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
	const existingTheme = savedCustomThemes.find(
		(item) => item.name === draftName.trim(),
	);
	const saved =
		themeFamily === "custom" &&
		themeCustomName === draftName.trim() &&
		existingTheme !== undefined &&
		(supportsThemeTokens
			? themeTokensKey(existingTheme.tokens ?? {})
			: existingTheme.css) === draftKey &&
		currentKey === draftKey;

	return (
		<div
			className={cn(
				SETTINGS_CONTAINER_CLASS,
				supportsThemeTokens && "pb-[max(1rem,env(safe-area-inset-bottom))]",
			)}
		>
			<SettingsSection>
				<SettingsRow label={t("settings.themeMode")}>
					<Select
						value={theme}
						onValueChange={(value) => {
							if (value === "light" || value === "dark" || value === "system") {
								updateSettings({ theme: value });
							}
						}}
					>
						<SelectTrigger
							aria-label={t("settings.themeMode")}
							className={cn(
								SETTINGS_CONTROL_CLASS,
								"w-full sm:w-[180px] pointer-coarse:min-h-11",
							)}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{THEME_MODES.map(({ value, label }) => (
								<SelectItem
									key={value}
									value={value}
									className="pointer-coarse:min-h-11"
								>
									{t(label)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title={t("settings.themeFamily")}>
				<div className="flex flex-wrap items-center gap-2 p-3">
					{THEME_FAMILIES.map(({ value, label }) => {
						const selected = themeFamily === value;
						return (
							<ThemeOption
								key={value}
								selected={selected}
								onSelect={() => updateSettings({ themeFamily: value })}
								label={t(label)}
							/>
						);
					})}
					{savedCustomThemes.map((item) => {
						const selected =
							themeFamily === "custom" && activeSavedTheme?.name === item.name;
						return (
							<ThemeOption
								key={item.name}
								selected={selected}
								onSelect={() => {
									updateSettings({
										themeFamily: "custom",
										...(supportsThemeTokens
											? { themeCustomTokens: item.tokens ?? {} }
											: { themeCustomCss: item.css }),
										themeCustomName: item.name,
									});
									setDraftName(item.name);
									setDraftTokens(editableThemeTokens(item.tokens ?? {}));
									setDraftCss(item.css);
								}}
								onDelete={() => setDeleteTarget(item.name)}
								label={item.name}
							/>
						);
					})}
				</div>
			</SettingsSection>

			<SettingsSection
				title={t(
					supportsThemeTokens
						? "settings.themeCustomTokens"
						: "settings.themeCustomCss",
				)}
				headerRight={
					<Button
						asChild
						variant="ghost"
						size="sm"
						className="gap-1.5 px-2 font-normal pointer-coarse:min-h-11"
					>
						<a
							href={`${REPOSITORY_URL}/blob/main/${supportsThemeTokens ? "desktop/README.md#custom-themes" : "docs/THEMES.md"}`}
							target="_blank"
							rel="noopener noreferrer"
						>
							{t("settings.themeDocumentation")}
							<ExternalLink aria-hidden="true" className="size-3.5" />
						</a>
					</Button>
				}
			>
				<SettingsRow label={t("settings.themeName")}>
					<Input
						aria-label={t("settings.themeName")}
						value={draftName}
						onChange={(event) => setDraftName(event.target.value)}
						placeholder={t("settings.themeNamePlaceholder")}
						className="w-full sm:w-64 pointer-coarse:min-h-11"
					/>
				</SettingsRow>
				<div className="space-y-3 p-3">
					{supportsThemeTokens ? (
						<>
							<ThemeConversionNotice
								conversion={themeCustomConversion}
								savedThemeName={sourceName}
							/>
							<ThemeTokenEditor
								tokens={draftTokens}
								onChange={setDraftTokens}
							/>
						</>
					) : (
						<Textarea
							aria-label={t("settings.themeCustomCss")}
							value={draftCss}
							onChange={(event) => setDraftCss(event.target.value)}
							placeholder={CUSTOM_CSS_PLACEHOLDER}
							spellCheck={false}
							autoCapitalize="off"
							autoCorrect="off"
							rows={14}
							className="min-h-56 resize-y font-mono text-xs leading-[1.6] [tab-size:2]"
						/>
					)}
					<div className="flex flex-wrap items-center justify-end gap-2">
						{saved ? (
							<output className="text-xs text-muted-foreground">
								{t("settings.themeSaved")}
							</output>
						) : null}
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className={
								supportsThemeTokens ? "min-h-11" : "pointer-coarse:min-h-11"
							}
							disabled={
								draftKey === currentKey &&
								draftName === (activeSavedTheme?.name ?? "")
							}
							onClick={() => {
								setDraftTokens(editableThemeTokens(themeCustomTokens));
								setDraftCss(themeCustomCss);
								setDraftName(activeSavedTheme?.name ?? "");
							}}
						>
							{t("common.cancel")}
						</Button>
						<Button
							type="button"
							size="sm"
							className={
								supportsThemeTokens ? "min-h-11" : "pointer-coarse:min-h-11"
							}
							disabled={
								!draftName.trim() ||
								saved ||
								(supportsThemeTokens && !validation.ok)
							}
							onClick={() => {
								if (supportsThemeTokens && !validation.ok) return;
								updateSettings({
									themeFamily: "custom",
									saveCustomTheme: {
										name: draftName,
										...(supportsThemeTokens
											? { tokens: validation.ok ? validation.tokens : {} }
											: { css: draftCss }),
									},
								});
								setDraftName(draftName.trim());
							}}
						>
							{t(existingTheme ? "settings.updateTheme" : "settings.saveTheme")}
						</Button>
					</div>
				</div>
			</SettingsSection>
			<SettingsConfirmDialog
				open={deleteTarget !== null}
				title={t("settings.deleteTheme", { name: deleteTarget ?? "" })}
				description={t("settings.deleteThemeDescription")}
				confirmLabel={t("common.delete")}
				destructive
				onOpenChange={(open) => {
					if (!open) setDeleteTarget(null);
				}}
				onConfirm={() => {
					if (deleteTarget !== null)
						updateSettings({ deleteCustomTheme: deleteTarget });
					setDeleteTarget(null);
				}}
			/>
		</div>
	);
}

function ThemeOption({
	label,
	selected,
	onSelect,
	onDelete,
}: {
	label: string;
	selected: boolean;
	onSelect: () => void;
	onDelete?: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div
			className={cn(
				"inline-flex max-w-full min-w-0 items-center overflow-hidden rounded-md border border-border/70 bg-background",
				selected && "ring-1 ring-ring",
			)}
		>
			<button
				type="button"
				aria-pressed={selected}
				onClick={onSelect}
				className="flex h-8 min-w-0 items-center gap-1.5 px-2.5 text-start text-xs font-medium hover:bg-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11"
			>
				<span className="truncate">{label}</span>
				{selected ? (
					<Check
						aria-hidden="true"
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
				) : null}
			</button>
			{onDelete ? (
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="mr-0.5 size-7 shrink-0 rounded-[max(0px,calc(var(--pilo-ui-radius-md)-0.125rem-1px))] text-muted-foreground hover:text-destructive pointer-coarse:mr-0 pointer-coarse:size-11 pointer-coarse:rounded-[max(0px,calc(var(--pilo-ui-radius-md)-1px))]"
					aria-label={t("settings.deleteTheme", { name: label })}
					onClick={onDelete}
				>
					<Trash2 aria-hidden="true" className="size-3.5" />
				</Button>
			) : null}
		</div>
	);
}
