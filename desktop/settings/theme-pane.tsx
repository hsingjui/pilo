import {
	type Accessor,
	effect,
	openUrl,
	signal,
	Text,
	untracked,
	View,
} from "nsh";

import type { ThemeSettingsUpdate } from "@/lib/theme-settings-types";
import type { CustomThemeTokens } from "@/lib/theme-tokens";
import { editableThemeTokens, themeTokensKey } from "@/lib/theme-token-draft";
import { validateCustomThemeTokens } from "@/lib/theme-tokens";
import { CUSTOM_THEME_CATALOG } from "@/lib/theme-web";
import type { AppState } from "../state/app-state";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { classNames } from "../ui/class-names";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { SettingsRow, SettingsSection } from "./layout";
import { SettingsConfirmDialog } from "./settings-confirm-dialog";
import { ThemeConversionNotice } from "./theme-conversion-notice";
import { ThemeTokenEditor } from "./theme-token-editor";
import type { SettingsClient } from "./settings-dialog";

const REPOSITORY_URL = "https://github.com/hsingjui/pilo";
const CUSTOM_THEME_DOCS_URL = `${REPOSITORY_URL}/blob/main/desktop/README.md#custom-themes`;

const THEME_MODES = [
	{ value: "light", labelKey: "settings.light" },
	{ value: "dark", labelKey: "settings.dark" },
	{ value: "system", labelKey: "settings.system" },
] as const;

// i18n 初期化後に評価されるよう items は遅延生成する。
const modeItems = () =>
	THEME_MODES.map((mode) => ({
		value: mode.value,
		title: String(t(mode.labelKey)),
	}));

const THEME_FAMILIES = [
	{ value: "lody", labelKey: "settings.themeFamilyLody" },
	{ value: "claude", labelKey: "settings.themeFamilyClaude" },
] as const;

/** One selectable theme chip; custom themes carry a delete button. */
function ThemeOption(props: {
	label: string;
	selected: boolean;
	onSelect: () => void;
	onDelete?: () => void;
	testID?: string;
}) {
	return (
		<View
			class={classNames(
				"h-8 flex-row items-center gap-1.5 rounded-md border border-border/70 bg-background px-2.5",
				props.selected && "border-ring",
			)}
			onPress={props.onSelect}
			testID={props.testID}
		>
			<Text class="truncate text-xs font-medium">{props.label}</Text>
			{props.selected ? (
				<Icon name="Check" size={14} class="text-muted-foreground" />
			) : null}
			{props.onDelete ? (
				<Button
					variant="ghost"
					size="icon"
					class="size-6 shrink-0"
					testID={props.testID ? `${props.testID}-delete` : undefined}
					accessibilityLabel={props.label}
					onPress={props.onDelete}
				>
					<Icon name="Trash2" size={13} class="text-muted-foreground" />
				</Button>
			) : null}
		</View>
	);
}

/**
 * Appearance: theme mode, theme family (Lody / Claude / saved customs), and
 * the custom-theme token table, matching `appearance-settings.tsx`.
 */
export function ThemePane(props: {
	state: Accessor<AppState>;
	client: SettingsClient;
}) {
	const settings = () => props.state().themeSettings;
	const save = (update: ThemeSettingsUpdate) => {
		props.client.saveThemeSettings(update).catch((error: unknown) => {
			console.error(t("settings.themeSaveFailed"), error);
		});
	};

	// The saved theme the settings point at: same name AND same token table.
	const activeSavedTheme = () =>
		settings()?.savedCustomThemes?.find(
			(item) =>
				item.name === settings()?.themeCustomName &&
				themeTokensKey(item.tokens ?? {}) ===
					themeTokensKey(settings()?.themeCustomTokens ?? {}),
		);
	const sourceName = () => activeSavedTheme()?.name ?? "";
	const currentKey = () => themeTokensKey(settings()?.themeCustomTokens ?? {});

	const draftName = signal(sourceName());
	const draftTokens = signal<CustomThemeTokens>(
		editableThemeTokens(settings()?.themeCustomTokens ?? {}),
	);
	const draftKey = () => themeTokensKey(draftTokens());
	// The last remote draft source adopted. Remote edits (theme_settings_changed
	// from another view) flow into the draft only while the local draft still
	// matches what the remote was when adopted, so they never clobber typing.
	const draftSource = signal({ key: currentKey(), name: sourceName() });
	effect(() => {
		const next = { key: currentKey(), name: sourceName() };
		const source = draftSource();
		if (next.key === source.key && next.name === source.name) return;
		if (
			untracked(() => draftKey() === source.key) &&
			untracked(() => draftName() === source.name)
		) {
			draftTokens.set(editableThemeTokens(settings()?.themeCustomTokens ?? {}));
			draftName.set(next.name);
		}
		draftSource.set(next);
	});

	const validation = () =>
		validateCustomThemeTokens(draftTokens(), CUSTOM_THEME_CATALOG);
	const existingTheme = () =>
		settings()?.savedCustomThemes?.find(
			(item) => item.name === draftName().trim(),
		);
	const saved = () =>
		settings()?.themeFamily === "custom" &&
		settings()?.themeCustomName === draftName().trim() &&
		existingTheme() !== undefined &&
		themeTokensKey(existingTheme()?.tokens ?? {}) === draftKey() &&
		currentKey() === draftKey();

	const selectSaved = (name: string, tokens: CustomThemeTokens | undefined) => {
		save({
			themeFamily: "custom",
			themeCustomTokens: tokens ?? {},
			themeCustomName: name,
		});
		draftName.set(name);
		draftTokens.set(editableThemeTokens(tokens ?? {}));
	};
	const deleting = signal<string | null>(null);
	const saveDraft = () => {
		const result = validation();
		if (!result.ok) return;
		save({
			themeFamily: "custom",
			saveCustomTheme: {
				name: draftName(),
				tokens: result.tokens,
			},
		});
		draftName.set(draftName().trim());
	};

	return (
		<View class="gap-3">
			<SettingsSection>
				<SettingsRow label={t("settings.themeMode")}>
					{() => (
						<Select
							testID="settings-theme-mode"
							class="w-[180px]"
							items={modeItems()}
							value={settings()?.theme ?? "system"}
							onChange={({ value }) => {
								if (value === "light" || value === "dark" || value === "system")
									save({ theme: value });
							}}
						/>
					)}
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title={t("settings.themeFamily")}>
				<View class="flex-row flex-wrap items-center gap-2 p-3">
					{THEME_FAMILIES.map((family) => (
						<ThemeOption
							testID={`settings-theme-family-${family.value}`}
							label={String(t(family.labelKey))}
							selected={settings()?.themeFamily === family.value}
							onSelect={() => save({ themeFamily: family.value })}
						/>
					))}
					{() =>
						(settings()?.savedCustomThemes ?? []).map((item) => (
							<ThemeOption
								testID={`settings-theme-saved-${item.name}`}
								label={item.name}
								selected={
									settings()?.themeFamily === "custom" &&
									settings()?.themeCustomName === item.name
								}
								onSelect={() => selectSaved(item.name, item.tokens)}
								onDelete={() => deleting.set(item.name)}
							/>
						))
					}
				</View>
			</SettingsSection>

			<SettingsSection
				title={t("settings.themeCustomTokens")}
				headerRight={
					<Button
						testID="settings-theme-docs"
						variant="ghost"
						size="sm"
						class="h-8 gap-1.5 px-2 text-xs font-normal text-muted-foreground"
						onPress={() => {
							void openUrl(CUSTOM_THEME_DOCS_URL).catch((error: unknown) =>
								console.error("openUrl failed", error),
							);
						}}
					>
						<Text class="text-xs">
							{() => String(t("settings.themeDocumentation"))}
						</Text>
						<Icon name="ExternalLink" size={14} class="opacity-60" />
					</Button>
				}
			>
				<SettingsRow label={t("settings.themeName")}>
					<Input
						testID="settings-theme-name"
						class="w-64"
						value={draftName()}
						placeholder={t("settings.themeNamePlaceholder")}
						onChange={({ value }) => draftName.set(value)}
					/>
				</SettingsRow>
				<View class="gap-3 p-3">
					<ThemeConversionNotice
						conversion={settings()?.themeCustomConversion}
						savedThemeName={sourceName()}
					/>
					<ThemeTokenEditor
						tokens={draftTokens}
						onChange={(tokens) => draftTokens.set(tokens)}
					/>
					<View class="flex-row flex-wrap items-center justify-end gap-2">
						{() =>
							saved() ? (
								<Text class="text-xs text-muted-foreground">
									{() => String(t("settings.themeSaved"))}
								</Text>
							) : null
						}
						{() => (
							<Button
								testID="settings-theme-cancel"
								variant="ghost"
								size="sm"
								disabled={
									draftKey() === currentKey() && draftName() === sourceName()
								}
								onPress={() => {
									draftTokens.set(
										editableThemeTokens(settings()?.themeCustomTokens ?? {}),
									);
									draftName.set(sourceName());
								}}
							>
								<Text>{t("common.cancel")}</Text>
							</Button>
						)}
						{() => (
							<Button
								testID="settings-theme-save"
								size="sm"
								disabled={!draftName().trim() || saved() || !validation().ok}
								onPress={saveDraft}
							>
								<Text>
									{t(
										existingTheme()
											? "settings.updateTheme"
											: "settings.saveTheme",
									)}
								</Text>
							</Button>
						)}
					</View>
				</View>
			</SettingsSection>
			{() => (
				<SettingsConfirmDialog
					testID="settings-theme-delete-dialog"
					open={deleting() !== null}
					title={t("settings.deleteTheme", { name: deleting() ?? "" })}
					description={t("settings.deleteThemeDescription")}
					confirmLabel={t("common.delete")}
					destructive
					onOpenChange={(open) => {
						if (!open) deleting.set(null);
					}}
					onConfirm={() => {
						const name = deleting();
						if (name !== null) save({ deleteCustomTheme: name });
						deleting.set(null);
					}}
				/>
			)}
		</View>
	);
}
