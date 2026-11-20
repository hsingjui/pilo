import { type Accessor, type JSX, Text, token, View, windowSize } from "nsh";

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
import { classNames } from "../ui/class-names";
import { Icon } from "../ui/icon";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { FontSelect, type FontSelectGroup } from "./font-select";
import { FontSizeInput } from "./font-size-input";
import { SettingsRow, SettingsSection } from "./layout";
import type { SettingsClient } from "./settings-dialog";

// i18n 初期化後に評価されるよう、groups は遅延生成する。システムフォントの
// 列挙はまだ Tauri ランタイム側にあるため、組み込みグループのみ。
const pageGroups = (): FontSelectGroup[] => [
	{ label: t("settings.builtIn"), options: PAGE_FONT_BUILTIN_OPTIONS },
];

const monoGroups = (): FontSelectGroup[] => [
	{ label: t("settings.builtIn"), options: MONOSPACE_FONT_BUILTIN_OPTIONS },
];

/**
 * Fonts: page / reading / code / terminal family + size. Built-in families
 * plus a family typed into the picker's search — system font enumeration
 * still lives in the Tauri runtime.
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
		label: string,
		value: number | undefined,
		fallback: number,
		range: FontSizeRange,
		saveValue: (next: number) => void,
	) => (
		<FontSizeInput
			testID={testID}
			class="w-20"
			label={label}
			min={range.min}
			max={range.max}
			value={value ?? fallback}
			onChange={saveValue}
		/>
	);
	const family = (
		testID: string,
		label: string,
		groups: FontSelectGroup[],
		value: string | undefined,
		fallback: string,
		saveValue: (next: string) => void,
		monospace = false,
	) => (
		<FontSelect
			testID={testID}
			class={monospace ? "w-[200px] font-mono" : "w-[200px]"}
			accessibilityLabel={label}
			groups={groups}
			value={value ?? fallback}
			onChange={saveValue}
		/>
	);
	/** Tailwind's sm:, as SettingsRow's; under it the label stacks above. */
	const narrow = () => windowSize().width < 640;
	/** A preview row as the Tauri's `sm:grid-cols-[120px_minmax(0,1fr)]`. */
	const previewRow = (label: string, content: JSX.Element) => (
		<View
			class={classNames(
				"min-w-0 px-3 py-3 border-b border-border/60 last:border-b-0",
				narrow() ? "gap-2" : "flex-row items-start gap-4",
			)}
		>
			<View class={narrow() ? undefined : "w-[120px] shrink-0"}>
				<Text class="pt-1 text-xs text-muted-foreground">{label}</Text>
			</View>
			<View class="min-w-0 flex-1">{content}</View>
		</View>
	);
	return (
		<View class="gap-3">
			<SettingsSection
				title={t("settings.font")}
				actions={
					<Menu
						align="end"
						trigger={
							<Button testID="settings-fonts-reset" variant="ghost" size="sm">
								<Text>{t("settings.resetDefault")}</Text>
								<Icon name="ChevronDown" size={14} />
							</Button>
						}
					>
						<MenuItem
							testID="settings-fonts-reset-families"
							onSelect={() =>
								save({
									pageFontFamily: DEFAULT_PAGE_FONT_FAMILY,
									readingFontFamily: DEFAULT_READING_FONT_FAMILY,
									codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
									terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
								})
							}
						>
							{t("settings.resetFonts")}
						</MenuItem>
						<MenuItem
							testID="settings-fonts-reset-sizes"
							onSelect={() =>
								save({
									uiFontSize: DEFAULT_UI_FONT_SIZE,
									readingFontSize: DEFAULT_READING_FONT_SIZE,
									codeFontSize: DEFAULT_CODE_FONT_SIZE,
									terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
								})
							}
						>
							{t("settings.resetFontSizes")}
						</MenuItem>
					</Menu>
				}
			>
				<SettingsRow label={t("settings.pageFont")}>
					{() =>
						family(
							"settings-page-font",
							t("settings.pageFont"),
							pageGroups(),
							values()?.pageFontFamily,
							DEFAULT_PAGE_FONT_FAMILY,
							(next) => save({ pageFontFamily: next }),
						)
					}
					{() =>
						size(
							"settings-ui-font-size",
							t("settings.pageFont"),
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
							t("settings.readingFont"),
							pageGroups(),
							values()?.readingFontFamily,
							DEFAULT_READING_FONT_FAMILY,
							(next) => save({ readingFontFamily: next }),
						)
					}
					{() =>
						size(
							"settings-reading-font-size",
							t("settings.readingFont"),
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
							t("settings.codeFont"),
							monoGroups(),
							values()?.codeFontFamily,
							DEFAULT_CODE_FONT_FAMILY,
							(next) => save({ codeFontFamily: next }),
							true,
						)
					}
					{() =>
						size(
							"settings-code-font-size",
							t("settings.codeFont"),
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
							t("settings.terminalFont"),
							monoGroups(),
							values()?.terminalFontFamily,
							DEFAULT_TERMINAL_FONT_FAMILY,
							(next) => save({ terminalFontFamily: next }),
							true,
						)
					}
					{() =>
						size(
							"settings-terminal-font-size",
							t("settings.terminalFont"),
							values()?.terminalFontSize,
							DEFAULT_TERMINAL_FONT_SIZE,
							TERMINAL_FONT_SIZE_RANGE,
							(next) => save({ terminalFontSize: next }),
						)
					}
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title={t("settings.fontPreview")}>
				{previewRow(
					t("settings.pageFont"),
					<View class="rounded-md border border-border/60 bg-background p-3 gap-1.5">
						{() => (
							<Text
								class="text-sm font-medium"
								style={{
									fontFamily: getPageFontFamilyStack(
										values()?.pageFontFamily ?? DEFAULT_PAGE_FONT_FAMILY,
									),
								}}
							>
								{t("settings.title")}
							</Text>
						)}
						{() => (
							<Text
								class="text-xs leading-[1.45] text-muted-foreground"
								style={{
									fontFamily: getPageFontFamilyStack(
										values()?.pageFontFamily ?? DEFAULT_PAGE_FONT_FAMILY,
									),
								}}
							>
								{t("settings.fontPreviewText")}
							</Text>
						)}
					</View>,
				)}
				{previewRow(
					t("settings.readingFont"),
					<View class="min-w-0 flex-1 gap-2">
						{() => (
							<Text
								class="font-semibold leading-[1.75]"
								style={{
									fontFamily: getPageFontFamilyStack(
										values()?.readingFontFamily ?? DEFAULT_READING_FONT_FAMILY,
									),
									fontSize:
										values()?.readingFontSize ?? DEFAULT_READING_FONT_SIZE,
								}}
							>
								{t("settings.fontPreviewHeading")}
							</Text>
						)}
						{() => (
							<Text
								class="leading-[1.75]"
								style={{
									fontFamily: getPageFontFamilyStack(
										values()?.readingFontFamily ?? DEFAULT_READING_FONT_FAMILY,
									),
									fontSize:
										values()?.readingFontSize ?? DEFAULT_READING_FONT_SIZE,
								}}
							>
								{t("settings.fontPreviewReadingText")}
							</Text>
						)}
						{() => (
							<Text
								class="leading-[1.75]"
								style={{
									fontFamily: getPageFontFamilyStack(
										values()?.readingFontFamily ?? DEFAULT_READING_FONT_FAMILY,
									),
									fontSize:
										values()?.readingFontSize ?? DEFAULT_READING_FONT_SIZE,
								}}
							>
								{t("settings.fontPreviewText")}
							</Text>
						)}
					</View>,
				)}
				{previewRow(
					t("settings.codeFont"),
					<View class="min-w-0 flex-1 overflow-hidden rounded-md border border-code-border bg-code-background">
						<View class="border-b border-code-border px-3 py-1.5">
							<Text class="text-[10px] text-muted-foreground">TypeScript</Text>
						</View>
						<View class="p-3">
							{() => (
								<Text
									class="font-sans text-code-foreground leading-[1.4]"
									style={{
										fontFamily: getMonospaceFontFamilyStack(
											values()?.codeFontFamily ?? DEFAULT_CODE_FONT_FAMILY,
										),
										fontSize: values()?.codeFontSize ?? DEFAULT_CODE_FONT_SIZE,
									}}
								>
									<Text class="text-syntax-keyword">const</Text>
									{" message = "}
									<Text class="text-syntax-string">{'"Hello, 你好！"'}</Text>
									{";\n"}
									<Text class="text-syntax-keyword">const</Text>
									{" count = "}
									<Text class="text-syntax-number">12345</Text>
									{";\n"}
									<Text class="text-syntax-function">console.log</Text>
									{"(message, count);"}
								</Text>
							)}
						</View>
					</View>,
				)}
				{previewRow(
					t("settings.terminalFont"),
					<View class="min-w-0 flex-1 rounded-md border border-border/60 bg-background p-3">
						{() => {
							const fontSize =
								values()?.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE;
							return (
								<Text
									class="font-sans leading-[1.15]"
									style={{
										fontFamily: getMonospaceFontFamilyStack(
											values()?.terminalFontFamily ??
												DEFAULT_TERMINAL_FONT_FAMILY,
										),
										fontSize,
									}}
								>
									<Text class="text-muted-foreground">~/pilo</Text>
									{' $ echo "Hello, 你好！ 0123456789"\n'}
									{"Hello, 你好！ 0123456789\n"}
									<Text class="text-muted-foreground">~/pilo</Text>
									{" $ "}
									<View
										style={{
											width: Math.round(fontSize * 0.6),
											height: fontSize,
											backgroundColor: token("foreground"),
										}}
									/>
								</Text>
							);
						}}
					</View>,
				)}
			</SettingsSection>
		</View>
	);
}
