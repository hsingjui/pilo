export type PageFontFamily =
	| "inter"
	| "system-sans"
	| "pingfang-sc"
	| "microsoft-yahei"
	| "segoe-ui"
	| "helvetica-neue"
	| "arial"
	| "roboto"
	| "noto-sans"
	| "noto-sans-sc"
	| "harmonyos-sans"
	| "source-han-sans-sc";

export type MonospaceFontFamily =
	| "jetbrains-mono"
	| "system-mono"
	| "sf-mono"
	| "menlo"
	| "monaco"
	| "consolas"
	| "fira-code"
	| "cascadia-code"
	| "cascadia-mono"
	| "source-code-pro"
	| "ibm-plex-mono"
	| "iosevka"
	| "hack"
	| "maple-mono"
	| "sarasa-mono-sc";

export const PAGE_FONT_OPTIONS: ReadonlyArray<{
	value: PageFontFamily;
	label: string;
}> = [
	{ value: "inter", label: "Inter" },
	{ value: "system-sans", label: "系统默认" },
	{ value: "pingfang-sc", label: "PingFang SC" },
	{ value: "microsoft-yahei", label: "Microsoft YaHei" },
	{ value: "segoe-ui", label: "Segoe UI" },
	{ value: "helvetica-neue", label: "Helvetica Neue" },
	{ value: "arial", label: "Arial" },
	{ value: "roboto", label: "Roboto" },
	{ value: "noto-sans", label: "Noto Sans" },
	{ value: "noto-sans-sc", label: "Noto Sans SC" },
	{ value: "harmonyos-sans", label: "HarmonyOS Sans" },
	{ value: "source-han-sans-sc", label: "Source Han Sans SC" },
];

export const MONOSPACE_FONT_OPTIONS: ReadonlyArray<{
	value: MonospaceFontFamily;
	label: string;
}> = [
	{ value: "jetbrains-mono", label: "JetBrains Mono" },
	{ value: "system-mono", label: "系统等宽" },
	{ value: "sf-mono", label: "SF Mono" },
	{ value: "menlo", label: "Menlo" },
	{ value: "monaco", label: "Monaco" },
	{ value: "consolas", label: "Consolas" },
	{ value: "fira-code", label: "Fira Code" },
	{ value: "cascadia-code", label: "Cascadia Code" },
	{ value: "cascadia-mono", label: "Cascadia Mono" },
	{ value: "source-code-pro", label: "Source Code Pro" },
	{ value: "ibm-plex-mono", label: "IBM Plex Mono" },
	{ value: "iosevka", label: "Iosevka" },
	{ value: "hack", label: "Hack" },
	{ value: "maple-mono", label: "Maple Mono" },
	{ value: "sarasa-mono-sc", label: "Sarasa Mono SC" },
];

export const PAGE_FONT_SIZES = [12, 13, 14, 15, 16, 17, 18] as const;
export const CODE_FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18] as const;
export const TERMINAL_FONT_SIZES = [
	10, 11, 12, 13, 14, 15, 16, 17, 18, 20,
] as const;

export type PageFontSize = (typeof PAGE_FONT_SIZES)[number];
export type CodeFontSize = (typeof CODE_FONT_SIZES)[number];
export type TerminalFontSize = (typeof TERMINAL_FONT_SIZES)[number];

export const DEFAULT_PAGE_FONT_FAMILY: PageFontFamily = "inter";
export const DEFAULT_PAGE_FONT_SIZE: PageFontSize = 14;
export const DEFAULT_CODE_FONT_FAMILY: MonospaceFontFamily = "jetbrains-mono";
export const DEFAULT_CODE_FONT_SIZE: CodeFontSize = 12;
export const DEFAULT_TERMINAL_FONT_FAMILY: MonospaceFontFamily =
	"jetbrains-mono";
export const DEFAULT_TERMINAL_FONT_SIZE: TerminalFontSize = 12;

const PAGE_FONT_STACKS: Record<PageFontFamily, string> = {
	inter:
		'"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Helvetica Neue", Arial, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Apple Color Emoji", "Segoe UI Emoji", sans-serif',
	"system-sans":
		'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Helvetica Neue", Arial, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Apple Color Emoji", "Segoe UI Emoji", sans-serif',
	"pingfang-sc":
		'"PingFang SC", "Noto Sans SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif',
	"microsoft-yahei":
		'"Microsoft YaHei", "Noto Sans SC", "PingFang SC", system-ui, sans-serif',
	"segoe-ui":
		'"Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, "Noto Sans SC", "Microsoft YaHei", sans-serif',
	"helvetica-neue":
		'"Helvetica Neue", Helvetica, Arial, system-ui, -apple-system, sans-serif',
	arial: 'Arial, "Helvetica Neue", Helvetica, system-ui, sans-serif',
	roboto:
		'"Roboto", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif',
	"noto-sans":
		'"Noto Sans", "Noto Sans SC", system-ui, -apple-system, "Segoe UI", sans-serif',
	"noto-sans-sc":
		'"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
	"harmonyos-sans":
		'"HarmonyOS Sans", "HarmonyOS Sans SC", "Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
	"source-han-sans-sc":
		'"Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
};

const MONOSPACE_FONT_STACKS: Record<MonospaceFontFamily, string> = {
	"jetbrains-mono":
		'"JetBrains Mono", ui-monospace, "SF Mono", "SFMono-Regular", "Monaco", "Menlo", "Consolas", "Liberation Mono", "Courier New", monospace',
	"system-mono":
		'ui-monospace, "SF Mono", "SFMono-Regular", "Monaco", "Menlo", "Consolas", "Liberation Mono", "Courier New", monospace',
	"sf-mono":
		'"SF Mono", "SFMono-Regular", ui-monospace, "Menlo", "Monaco", "Consolas", monospace',
	menlo: '"Menlo", ui-monospace, "SF Mono", "Monaco", "Consolas", monospace',
	monaco: '"Monaco", ui-monospace, "SF Mono", "Menlo", "Consolas", monospace',
	consolas:
		'"Consolas", ui-monospace, "SF Mono", "Menlo", "Monaco", "Liberation Mono", monospace',
	"fira-code":
		'"Fira Code", "JetBrains Mono", ui-monospace, "SF Mono", "Consolas", monospace',
	"cascadia-code":
		'"Cascadia Code", "Cascadia Mono", "Consolas", ui-monospace, monospace',
	"cascadia-mono":
		'"Cascadia Mono", "Cascadia Code", "Consolas", ui-monospace, monospace',
	"source-code-pro":
		'"Source Code Pro", "JetBrains Mono", ui-monospace, "SF Mono", monospace',
	"ibm-plex-mono":
		'"IBM Plex Mono", "JetBrains Mono", ui-monospace, "SF Mono", monospace',
	iosevka: '"Iosevka", "JetBrains Mono", ui-monospace, monospace',
	hack: '"Hack", "JetBrains Mono", ui-monospace, monospace',
	"maple-mono": '"Maple Mono", "JetBrains Mono", ui-monospace, monospace',
	"sarasa-mono-sc":
		'"Sarasa Mono SC", "JetBrains Mono", ui-monospace, "Microsoft YaHei", monospace',
};

const MAX_CUSTOM_FONT_FAMILY_LENGTH = 360;
const MAX_CUSTOM_FONT_FAMILIES = 12;

export function normalizeCustomFontFamily(value: unknown) {
	if (typeof value !== "string") return "";
	const sanitized = Array.from(value, (character) => character.charCodeAt(0))
		.filter((code) => code > 31 && code !== 127)
		.map((code) => String.fromCharCode(code))
		.join("");
	return sanitized.trim().slice(0, MAX_CUSTOM_FONT_FAMILY_LENGTH);
}

function normalizeFontFamilyEntry(value: string) {
	const unquoted = value
		.trim()
		.replace(/^["']|["']$/g, "")
		.trim();
	if (!unquoted) return "";
	if (
		/^(serif|sans-serif|monospace|system-ui|ui-sans-serif|ui-monospace)$/i.test(
			unquoted,
		)
	) {
		return unquoted;
	}
	return `"${unquoted.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function customFontFamilyStack(value: string) {
	return normalizeCustomFontFamily(value)
		.split(",")
		.slice(0, MAX_CUSTOM_FONT_FAMILIES)
		.map(normalizeFontFamilyEntry)
		.filter(Boolean)
		.join(", ");
}

export function getPageFontFamilyStack(
	value: PageFontFamily,
	customFontFamily = "",
) {
	const custom = customFontFamilyStack(customFontFamily);
	return custom
		? `${custom}, ${PAGE_FONT_STACKS[value]}`
		: PAGE_FONT_STACKS[value];
}

export function getMonospaceFontFamilyStack(
	value: MonospaceFontFamily,
	customFontFamily = "",
) {
	const custom = customFontFamilyStack(customFontFamily);
	return custom
		? `${custom}, ${MONOSPACE_FONT_STACKS[value]}`
		: MONOSPACE_FONT_STACKS[value];
}

export function isPageFontFamily(value: unknown): value is PageFontFamily {
	return PAGE_FONT_OPTIONS.some((option) => option.value === value);
}

export function isMonospaceFontFamily(
	value: unknown,
): value is MonospaceFontFamily {
	return MONOSPACE_FONT_OPTIONS.some((option) => option.value === value);
}

export function isPageFontSize(value: unknown): value is PageFontSize {
	return PAGE_FONT_SIZES.some((size) => size === value);
}

export function isCodeFontSize(value: unknown): value is CodeFontSize {
	return CODE_FONT_SIZES.some((size) => size === value);
}

export function isTerminalFontSize(value: unknown): value is TerminalFontSize {
	return TERMINAL_FONT_SIZES.some((size) => size === value);
}
