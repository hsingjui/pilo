import { type Accessor, Text, View } from "nsh";
import { NumberInput } from "nsh/base";

import {
	CODE_FONT_SIZE_RANGE,
	DEFAULT_CODE_FONT_FAMILY,
	DEFAULT_CODE_FONT_SIZE,
	DEFAULT_PAGE_FONT_FAMILY,
	DEFAULT_READING_FONT_FAMILY,
	DEFAULT_READING_FONT_SIZE,
	DEFAULT_TERMINAL_FONT_FAMILY,
	DEFAULT_TERMINAL_FONT_SIZE,
	DEFAULT_UI_FONT_SIZE,
	MONOSPACE_FONT_BUILTIN_OPTIONS,
	PAGE_FONT_BUILTIN_OPTIONS,
	READING_FONT_SIZE_RANGE,
	TERMINAL_FONT_SIZE_RANGE,
	UI_FONT_SIZE_RANGE,
	getMonospaceFontFamilyStack,
	getPageFontFamilyStack,
	type FontSizeRange,
} from "@/lib/font-settings";
import type { PreferencePatch } from "@/lib/host-preferences-types";
import type { AppState } from "../state/app-state";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Select, type SelectItem } from "../ui/select";
import { SettingsRow, SettingsSection } from "./layout";
import type { SettingsClient } from "./settings-dialog";

// i18n 初期化後に評価されるよう、Select items は遅延生成する。
const pageItems = (): SelectItem[] =>
	PAGE_FONT_BUILTIN_OPTIONS.map((option) => ({
		value: option.value,
		title: option.label || t("settings.systemDefault"),
		group: t("settings.builtIn"),
	}));

const monoItems = (): SelectItem[] =>
	MONOSPACE_FONT_BUILTIN_OPTIONS.map((option) => ({
		value: option.value,
		title: option.label || t("settings.systemMonospace"),
		group: t("settings.builtIn"),
	}));

/**
 * Fonts: page / reading / code / terminal family + size. Built-in families
 * only — system font enumeration still lives in the Tauri runtime.
 */
export function FontsPane(props: {
	state: Accessor<AppState>;
	client: SettingsClient;
}) {
	const values = () => props.state().preferences?.values;
	const save = (patch: PreferencePatch) => {
		props.client.savePreferences(patch).catch((error: unknown) => {
			console.error(t("settings.preferencesSaveFailed"), error);
		});
	};
	const size = (
		testID: string,
		value: number | undefined,
		fallback: number,
		range: FontSizeRange,
		saveValue: (next: number) => void,
	) => (
		<NumberInput
			testID={testID}
			class="w-20"
			min={range.min}
			max={range.max}
			step={1}
			value={value ?? fallback}
			onChange={({ value: next }) => {
				if (next !== null && next >= range.min && next <= range.max)
					saveValue(next);
			}}
		/>
	);
	const family = (
		testID: string,
		items: SelectItem[],
		value: string | undefined,
		fallback: string,
		saveValue: (next: string) => void,
	) => (
		<Select
			testID={testID}
			class="w-[200px]"
			items={items}
			value={value ?? fallback}
			onChange={({ value: next }) => {
				if (next) saveValue(next);
			}}
		/>
	);
	return (
		<View class="gap-3">
			<SettingsSection
				title={t("settings.font")}
				headerRight={
					<View class="flex-row gap-1">
						<Button
							testID="settings-fonts-reset-families"
							variant="ghost"
							onPress={() =>
								save({
									pageFontFamily: DEFAULT_PAGE_FONT_FAMILY,
									readingFontFamily: DEFAULT_READING_FONT_FAMILY,
									codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
									terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
								})
							}
						>
							{t("settings.resetFonts")}
						</Button>
						<Button
							testID="settings-fonts-reset-sizes"
							variant="ghost"
							onPress={() =>
								save({
									uiFontSize: DEFAULT_UI_FONT_SIZE,
									readingFontSize: DEFAULT_READING_FONT_SIZE,
									codeFontSize: DEFAULT_CODE_FONT_SIZE,
									terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
								})
							}
						>
							{t("settings.resetFontSizes")}
						</Button>
					</View>
				}
			>
				<SettingsRow label={t("settings.pageFont")}>
					{() =>
						family(
							"settings-page-font",
							pageItems(),
							values()?.pageFontFamily,
							DEFAULT_PAGE_FONT_FAMILY,
							(next) => save({ pageFontFamily: next }),
						)
					}
					{() =>
						size(
							"settings-ui-font-size",
							values()?.uiFontSize,
							DEFAULT_UI_FONT_SIZE,
							UI_FONT_SIZE_RANGE,
							(next) => save({ uiFontSize: next }),
						)
					}
				</SettingsRow>
				<SettingsRow
					label={t("settings.readingFont")}
					helper={t("settings.readingFontDescription")}
				>
					{() =>
						family(
							"settings-reading-font",
							pageItems(),
							values()?.readingFontFamily,
							DEFAULT_READING_FONT_FAMILY,
							(next) => save({ readingFontFamily: next }),
						)
					}
					{() =>
						size(
							"settings-reading-font-size",
							values()?.readingFontSize,
							DEFAULT_READING_FONT_SIZE,
							READING_FONT_SIZE_RANGE,
							(next) => save({ readingFontSize: next }),
						)
					}
				</SettingsRow>
				<SettingsRow label={t("settings.codeFont")}>
					{() =>
						family(
							"settings-code-font",
							monoItems(),
							values()?.codeFontFamily,
							DEFAULT_CODE_FONT_FAMILY,
							(next) => save({ codeFontFamily: next }),
						)
					}
					{() =>
						size(
							"settings-code-font-size",
							values()?.codeFontSize,
							DEFAULT_CODE_FONT_SIZE,
							CODE_FONT_SIZE_RANGE,
							(next) => save({ codeFontSize: next }),
						)
					}
				</SettingsRow>
				<SettingsRow label={t("settings.terminalFont")}>
					{() =>
						family(
							"settings-terminal-font",
							monoItems(),
							values()?.terminalFontFamily,
							DEFAULT_TERMINAL_FONT_FAMILY,
							(next) => save({ terminalFontFamily: next }),
						)
					}
					{() =>
						size(
							"settings-terminal-font-size",
							values()?.terminalFontSize,
							DEFAULT_TERMINAL_FONT_SIZE,
							TERMINAL_FONT_SIZE_RANGE,
							(next) => save({ terminalFontSize: next }),
						)
					}
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title={t("settings.fontPreview")}>
				<SettingsRow label={t("settings.codeFont")}>
					<View class="min-w-0 flex-1 rounded-md border border-border bg-muted/40 px-3 py-2">
						{() => (
							<Text
								style={{
									fontFamily: getMonospaceFontFamilyStack(
										values()?.codeFontFamily ?? DEFAULT_CODE_FONT_FAMILY,
									),
									fontSize: values()?.codeFontSize ?? DEFAULT_CODE_FONT_SIZE,
								}}
							>
								{'const message = "Hello, 你好！";'}
							</Text>
						)}
					</View>
				</SettingsRow>
				<SettingsRow label={t("settings.terminalFont")}>
					<View class="min-w-0 flex-1 rounded-md border border-border/60 bg-background px-3 py-2">
						{() => (
							<Text
								style={{
									fontFamily: getMonospaceFontFamilyStack(
										values()?.terminalFontFamily ??
											DEFAULT_TERMINAL_FONT_FAMILY,
									),
									fontSize:
										values()?.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE,
								}}
							>
								{'~/pilo $ echo "Hello, 你好！ 0123456789"'}
							</Text>
						)}
					</View>
				</SettingsRow>
			</SettingsSection>
		</View>
	);
}
