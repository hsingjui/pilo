import { type Accessor, signal, Text, View } from "nsh";
import { AlertDialog, Editor } from "nsh/base";

import type { ThemeSettingsUpdate } from "@/lib/theme-settings-types";
import type { CustomThemeTokens } from "@/lib/theme-tokens";
import {
	createThemeTokenCatalog,
	validateCustomThemeTokens,
} from "@/lib/theme-tokens";
import lody from "../theme.json";
import type { AppState } from "../state/app-state";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { classNames } from "../ui/class-names";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { SettingsRow, SettingsSection, SettingsStatus } from "./layout";
import type { SettingsClient } from "./settings-dialog";

const catalog = createThemeTokenCatalog(lody.cssVars);

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
					accessibilityLabel={props.label}
					onPress={props.onDelete}
				>
					<Icon name="Trash2" size={13} class="text-muted-foreground" />
				</Button>
			) : null}
		</View>
	);
}

function tokensJson(tokens: CustomThemeTokens | undefined): string {
	return JSON.stringify(tokens ?? {}, null, 2);
}

/**
 * Appearance: theme mode, theme family (Lody / Claude / saved customs), and a
 * JSON editor for the custom token table, saved through `saveThemeSettings`.
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
	const draftName = signal(settings()?.themeCustomName ?? "");
	const draftTokens = signal(tokensJson(settings()?.themeCustomTokens));
	const editing = signal(false);

	const parseDraft = () => {
		try {
			return { parsed: JSON.parse(draftTokens()) as unknown };
		} catch {
			return { parsed: undefined };
		}
	};
	const validation = () => {
		const { parsed } = parseDraft();
		if (parsed === undefined) return { ok: false as const, issue: "json" };
		const result = validateCustomThemeTokens(parsed, catalog);
		return result.ok
			? { ok: true as const, tokens: result.tokens }
			: { ok: false as const, issue: result.issues[0]?.code ?? "invalid" };
	};

	const selectSaved = (name: string, tokens: CustomThemeTokens | undefined) => {
		save({
			themeFamily: "custom",
			themeCustomTokens: tokens ?? {},
			themeCustomName: name,
		});
		draftName.set(name);
		draftTokens.set(tokensJson(tokens));
	};
	const deleteSaved = (name: string) => {
		void AlertDialog.show({
			title: t("settings.deleteTheme", { name }),
			description: t("settings.deleteThemeDescription"),
			actions: [
				{ id: "cancel", label: t("common.cancel"), role: "cancel" },
				{ id: "delete", label: t("common.delete"), role: "destructive" },
			],
		}).then(({ action }) => {
			if (action === "delete") save({ deleteCustomTheme: name });
		});
	};
	const saveDraft = () => {
		const result = validation();
		if (!result.ok || !draftName().trim()) return;
		save({
			themeFamily: "custom",
			saveCustomTheme: {
				name: draftName().trim(),
				tokens: result.tokens,
			},
		});
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
								onDelete={() => deleteSaved(item.name)}
							/>
						))
					}
				</View>
			</SettingsSection>

			<SettingsSection title={t("settings.themeCustomTokens")}>
				<SettingsRow label={t("settings.themeName")}>
					{() => (
						<Input
							testID="settings-theme-name"
							class="w-64"
							value={draftName()}
							placeholder={t("settings.themeNamePlaceholder")}
							onChange={({ value }) => {
								draftName.set(value);
								editing.set(true);
							}}
						/>
					)}
				</SettingsRow>
				<View class="gap-2 p-3">
					<Editor
						testID="settings-theme-tokens"
						language="json"
						softWrap
						class="h-56 w-full rounded-(--pilo-radius-md) border border-input-border bg-input-field"
						value={draftTokens()}
						onChange={({ value }) => {
							draftTokens.set(value);
							editing.set(true);
						}}
					/>
					{() => {
						const result = validation();
						return !result.ok && editing() ? (
							<Text class="text-xs text-destructive">
								{result.issue === "json"
									? t("settings.themeTokensInvalidJson")
									: t("settings.themeTokensInvalid", {
											code: result.issue,
										})}
							</Text>
						) : null;
					}}
					<View class="flex-row items-center justify-end gap-2">
						<Button
							testID="settings-theme-cancel"
							variant="ghost"
							disabled={!editing()}
							onPress={() => {
								draftName.set(settings()?.themeCustomName ?? "");
								draftTokens.set(tokensJson(settings()?.themeCustomTokens));
								editing.set(false);
							}}
						>
							{t("common.cancel")}
						</Button>
						<Button
							testID="settings-theme-save"
							disabled={!draftName().trim() || !validation().ok}
							onPress={saveDraft}
						>
							{t("settings.saveTheme")}
						</Button>
					</View>
				</View>
			</SettingsSection>
		</View>
	);
}
