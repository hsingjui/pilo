import { type Accessor, Text, token, View } from "nsh";
import { Button as BaseButton } from "nsh/base";

import { userErrorMessage } from "@shared/app-error";
import type { ThemeSettingsUpdate } from "@shared/theme-settings-types";
import { AppToaster, showToast } from "../shell/app-toasts";
import type { AppState } from "../state/app-state";
import { t } from "../shell/i18n";
import { classNames } from "../ui/class-names";
import { blurOnPointerPress, focusRingStyle } from "../ui/focus-ring-style";
import { Icon } from "../ui/icon";
import { Select } from "../ui/select";
import { SettingsRow, SettingsSection } from "./layout";
import type { SettingsClient } from "./settings-dialog";

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

/** One selectable built-in theme chip. */
function ThemeOption(props: {
	label: string;
	selected: boolean;
	onSelect: () => void;
	testID?: string;
}) {
	const pointerBlur = blurOnPointerPress();
	return (
		<BaseButton
			testID={props.testID}
			ref={pointerBlur.ref}
			onMouseUp={pointerBlur.onMouseUp}
			selected={props.selected}
			accessibilityLabel={props.label}
			class={classNames(
				"h-(--pilo-button-sm-height) flex-row items-center gap-1.5 rounded-md border border-border/70 bg-background px-2.5 transition-colors hover:bg-hover focus-visible:outline-hidden",
				props.selected && "border-ring",
			)}
			focusVisibleStyle={focusRingStyle(token("ring"))}
			onPress={props.onSelect}
		>
			<Text class="font-sans truncate text-xs font-medium text-foreground">
				{props.label}
			</Text>
			{props.selected ? (
				<Icon name="Check" size={14} color={token("muted-foreground")} />
			) : null}
		</BaseButton>
	);
}

/** Appearance: theme mode and built-in theme family. */
export function ThemePane(props: {
	state: Accessor<AppState>;
	client: SettingsClient;
}) {
	const toasts = AppToaster();
	const settings = () => props.state().themeSettings;
	const save = (update: ThemeSettingsUpdate) => {
		props.client.saveThemeSettings(update).catch((error: unknown) => {
			console.error(t("settings.themeSaveFailed"), error);
			showToast(toasts, {
				variant: "error",
				title: t("settings.themeSaveFailed"),
				description: userErrorMessage(error),
			});
		});
	};

	return (
		<View class="gap-3">
			<SettingsSection>
				<SettingsRow label={t("settings.themeMode")}>
					{() => (
						<Select
							testID="settings-theme-mode"
							size="sm"
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
				</View>
			</SettingsSection>
		</View>
	);
}
