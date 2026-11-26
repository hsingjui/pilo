import { type Accessor, colorScheme, Text, token, View } from "nsh";
import { Button as BaseButton } from "nsh/base";

import { userErrorMessage } from "@shared/app-error";
import type {
	BuiltinThemeFamily,
	ThemeSettingsUpdate,
} from "@shared/theme-settings-types";
import { AppToaster, showToast } from "../shell/app-toasts";
import { themePreviewColors } from "../shell/appearance";
import type { AppState } from "../state/app-state";
import { t } from "../shell/i18n";
import { classNames } from "../ui/class-names";
import { blurOnPointerPress, focusRingStyle } from "../ui/focus-ring-style";
import { Icon } from "../ui/icon";
import { springTransition, tactileTransition } from "../ui/motion";
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
	{ value: "grove", labelKey: "settings.themeFamilyGrove" },
	{ value: "ocean", labelKey: "settings.themeFamilyOcean" },
	{ value: "ember", labelKey: "settings.themeFamilyEmber" },
	{ value: "iris", labelKey: "settings.themeFamilyIris" },
] as const;

/** One selectable built-in theme chip. */
function ThemeOption(props: {
	family: BuiltinThemeFamily;
	label: string;
	selected: boolean;
	onSelect: () => void;
	testID?: string;
}) {
	const pointerBlur = blurOnPointerPress();
	const preview = () => themePreviewColors(props.family, colorScheme());
	return (
		<BaseButton
			testID={props.testID}
			ref={pointerBlur.ref}
			onMouseUp={pointerBlur.onMouseUp}
			selected={props.selected}
			accessibilityLabel={props.label}
			class={classNames(
				"h-(--pilo-button-sm-height) flex-row items-center gap-2 rounded-md border border-border/70 bg-background px-2.5 hover:bg-hover active:scale-[0.97] focus-visible:outline-hidden",
				props.selected && "border-ring",
			)}
			style={tactileTransition("background-color, border-color, scale")}
			focusVisibleStyle={focusRingStyle(token("ring"))}
			onPress={props.onSelect}
		>
			<View class="flex-row items-center gap-1">
				<View
					class="h-2.5 w-2.5 rounded-full border border-foreground/20"
					style={{ backgroundColor: preview().canvas }}
				/>
				<View
					class="h-2.5 w-2.5 rounded-full"
					style={{ backgroundColor: preview().accent }}
				/>
			</View>
			<Text class="font-sans truncate text-xs font-medium text-foreground">
				{props.label}
			</Text>
			{props.selected ? (
				<View style={springTransition("opacity, transform", "crisp")}>
					<Icon name="Check" size={14} color={token("muted-foreground")} />
				</View>
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
				<View class="gap-2 p-3">
					<View class="flex-row flex-wrap items-center gap-2">
						{THEME_FAMILIES.map((family) => (
							<ThemeOption
								family={family.value}
								testID={`settings-theme-family-${family.value}`}
								label={String(t(family.labelKey))}
								selected={settings()?.themeFamily === family.value}
								onSelect={() => save({ themeFamily: family.value })}
							/>
						))}
					</View>
					{() => {
						const activeFamily = settings()?.themeFamily;
						const isBuiltin =
							!activeFamily ||
							THEME_FAMILIES.some((family) => family.value === activeFamily);
						if (isBuiltin) return null;
						const customName = settings()?.themeCustomName?.trim();
						return (
							<View
								testID="settings-theme-custom-active"
								class="flex-row items-center gap-1.5 pt-1"
							>
								<Icon name="Check" size={13} color={token("primary")} />
								<Text class="font-sans text-xs text-muted-foreground">
									{() =>
										customName
											? `${t("settings.customThemeActive")} · ${customName}`
											: t("settings.customThemeActive")
									}
								</Text>
							</View>
						);
					}}
				</View>
			</SettingsSection>
		</View>
	);
}
