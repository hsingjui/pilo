import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	CODE_FONT_SIZES,
	DEFAULT_CODE_FONT_SIZE,
	DEFAULT_PAGE_FONT_SIZE,
	DEFAULT_TERMINAL_FONT_SIZE,
	MONOSPACE_FONT_BUILTIN_OPTIONS,
	PAGE_FONT_BUILTIN_OPTIONS,
	PAGE_FONT_SIZES,
	TERMINAL_FONT_SIZES,
	buildSystemFontOptions,
	filterSymbolFontFamilies,
	resolveSystemFontFamilies,
	resolveSystemMonospaceFamilies,
	type CodeFontSize,
	type PageFontSize,
	type TerminalFontSize,
} from "@/lib/font-settings";
import { usePreferences } from "@/lib/preferences-provider";
import { useTheme, type Theme } from "@/lib/theme-provider";
import { cn } from "@/lib/utils";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/ui";
import {
	SETTINGS_CONTAINER_CLASS,
	SETTINGS_CONTROL_CLASS,
	SettingsRow,
	SettingsSection,
} from "./compact-layout";
import { FontSelect, type FontSelectGroup } from "./font-select";

const THEME_LABEL_KEYS: Record<
	Theme,
	"settings.light" | "settings.dark" | "settings.system"
> = {
	light: "settings.light",
	dark: "settings.dark",
	system: "settings.system",
};

const FONT_SETTINGS_ROW_CLASS = "sm:grid-cols-[160px_1fr]";
const PAGE_FONT_SIZE_LABEL_KEYS = {
	12: "settings.fontSizeTiny",
	14: "settings.fontSizeSmall",
	16: "settings.fontSizeStandard",
	18: "settings.fontSizeLarge",
	20: "settings.fontSizeExtraLarge",
	22: "settings.fontSizeHuge",
} as const satisfies Record<PageFontSize, string>;

export function AppearanceSettings() {
	const { t } = useTranslation();
	const { theme, setTheme } = useTheme();
	const {
		pageFontFamily,
		setPageFontFamily,
		pageFontSize,
		setPageFontSize,
		codeFontFamily,
		setCodeFontFamily,
		codeFontSize,
		setCodeFontSize,
		terminalFontFamily,
		setTerminalFontFamily,
		terminalFontSize,
		setTerminalFontSize,
	} = usePreferences();
	const [systemPageFonts, setSystemPageFonts] = useState<readonly string[]>([]);
	const [systemMonospaceFonts, setSystemMonospaceFonts] = useState<
		readonly string[]
	>([]);

	useEffect(() => {
		let cancelled = false;
		void resolveSystemFontFamilies().then((families) => {
			if (!cancelled) setSystemPageFonts(filterSymbolFontFamilies(families));
		});
		void resolveSystemMonospaceFamilies().then((families) => {
			if (!cancelled) setSystemMonospaceFonts(families);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const pageFontGroups: FontSelectGroup[] = [
		{ label: t("settings.builtIn"), options: PAGE_FONT_BUILTIN_OPTIONS },
		{
			label: t("settings.systemFonts"),
			options: buildSystemFontOptions(systemPageFonts),
		},
	];
	const monospaceFontGroups: FontSelectGroup[] = [
		{ label: t("settings.builtIn"), options: MONOSPACE_FONT_BUILTIN_OPTIONS },
		{
			label: t("settings.systemMonospace"),
			options: buildSystemFontOptions(systemMonospaceFonts),
		},
	];

	return (
		<div className={SETTINGS_CONTAINER_CLASS}>
			<SettingsSection>
				<SettingsRow label={t("settings.theme")}>
					<Select
						value={theme}
						onValueChange={(value) => setTheme(value as Theme)}
					>
						<SelectTrigger className={cn(SETTINGS_CONTROL_CLASS, "w-[220px]")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(Object.keys(THEME_LABEL_KEYS) as Theme[]).map((value) => (
								<SelectItem key={value} value={value}>
									{t(THEME_LABEL_KEYS[value])}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title={t("settings.font")}>
				<SettingsRow
					label={t("settings.pageFont")}
					className={FONT_SETTINGS_ROW_CLASS}
				>
					<FontSelect
						value={pageFontFamily}
						groups={pageFontGroups}
						onChange={setPageFontFamily}
					/>
					<Select
						value={String(pageFontSize)}
						onValueChange={(value) =>
							setPageFontSize(Number(value) as PageFontSize)
						}
					>
						<SelectTrigger className={cn(SETTINGS_CONTROL_CLASS, "w-[104px]")}>
							<SelectValue>
								{t(PAGE_FONT_SIZE_LABEL_KEYS[pageFontSize])}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{PAGE_FONT_SIZES.map((size) => (
								<SelectItem key={size} value={String(size)}>
									<span className="inline-flex items-center gap-2">
										{t(PAGE_FONT_SIZE_LABEL_KEYS[size])}
										{size === DEFAULT_PAGE_FONT_SIZE ? (
											<span
												className="size-1.5 rounded-full bg-muted-foreground"
												aria-label={t("settings.defaultFontSize")}
											/>
										) : null}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>

				<SettingsRow
					label={t("settings.codeFont")}
					className={FONT_SETTINGS_ROW_CLASS}
				>
					<FontSelect
						value={codeFontFamily}
						groups={monospaceFontGroups}
						onChange={setCodeFontFamily}
						className="font-mono"
					/>
					<Select
						value={String(codeFontSize)}
						onValueChange={(value) =>
							setCodeFontSize(Number(value) as CodeFontSize)
						}
					>
						<SelectTrigger className={cn(SETTINGS_CONTROL_CLASS, "w-[104px]")}>
							<SelectValue>{codeFontSize}px</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{CODE_FONT_SIZES.map((size) => (
								<SelectItem key={size} value={String(size)}>
									<span className="inline-flex items-center gap-2">
										{size}px
										{size === DEFAULT_CODE_FONT_SIZE ? (
											<span
												className="size-1.5 rounded-full bg-muted-foreground"
												aria-label={t("settings.defaultFontSize")}
											/>
										) : null}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>

				<SettingsRow
					label={t("settings.terminalFont")}
					className={FONT_SETTINGS_ROW_CLASS}
				>
					<FontSelect
						value={terminalFontFamily}
						groups={monospaceFontGroups}
						onChange={setTerminalFontFamily}
					/>
					<Select
						value={String(terminalFontSize)}
						onValueChange={(value) =>
							setTerminalFontSize(Number(value) as TerminalFontSize)
						}
					>
						<SelectTrigger className={cn(SETTINGS_CONTROL_CLASS, "w-[104px]")}>
							<SelectValue>{terminalFontSize}px</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{TERMINAL_FONT_SIZES.map((size) => (
								<SelectItem key={size} value={String(size)}>
									<span className="inline-flex items-center gap-2">
										{size}px
										{size === DEFAULT_TERMINAL_FONT_SIZE ? (
											<span
												className="size-1.5 rounded-full bg-muted-foreground"
												aria-label={t("settings.defaultFontSize")}
											/>
										) : null}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}
