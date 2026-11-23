import type {
	CodeFontSize,
	MonospaceFontFamily,
	PageFontFamily,
	ReadingFontSize,
	TerminalFontSize,
	UiFontSize,
} from "./font-settings-types";

export type {
	CodeFontSize,
	MonospaceFontFamily,
	PageFontFamily,
	ReadingFontSize,
	TerminalFontSize,
	UiFontSize,
} from "./font-settings-types";

export type FontOption = {
	value: string;
	label: string;
	/** 内置字体项的可翻译标签 key；系统字体项没有。 */
	labelKey?: "settings.systemDefault" | "settings.systemMonospace";
	/** 下拉预览用的 CSS family；省略表示用应用默认字体渲染。 */
	family?: string;
};

export const PAGE_FONT_BUILTIN_OPTIONS: ReadonlyArray<FontOption> = [
	{ value: "inter", label: "Inter", family: "Inter" },
	{ value: "system-sans", label: "", labelKey: "settings.systemDefault" },
];

export const MONOSPACE_FONT_BUILTIN_OPTIONS: ReadonlyArray<FontOption> = [
	{
		value: "jetbrains-mono",
		label: "JetBrains Mono",
		family: "JetBrains Mono",
	},
	{ value: "system-mono", label: "", labelKey: "settings.systemMonospace" },
];

/** 宿主枚举出的系统字体族及其原生等宽判定。 */
export type SystemFontFamily = {
	family: string;
	monospace: boolean;
};

/** 随应用打包、已在内置分组出现的字体族；系统分组跳过它们。 */
const BUNDLED_FONT_FAMILIES = new Set(
	[...PAGE_FONT_BUILTIN_OPTIONS, ...MONOSPACE_FONT_BUILTIN_OPTIONS]
		.map((option) => option.family?.toLowerCase())
		.filter((family): family is string => Boolean(family)),
);

/**
 * 符号/图标字体（选中后文字会变成不可读字形），不进入页面字体候选；
 * 等宽候选已由原生等宽判定过滤。
 */
const SYMBOL_FONT_FAMILY_PATTERN =
	/\b(?:wingdings|webdings|marlett|dingbat|emoji|fluent icons|mdl\d|symbol)/i;

function systemFontOptions(families: Iterable<string>): FontOption[] {
	return [...families].map((family) => ({
		value: family,
		label: family,
		family,
	}));
}

/**
 * 系统字体的页面与等宽候选：去空白、大小写不敏感去重并按名称排序，
 * 跳过与内置字体重名的族；页面候选再去掉符号字体。
 */
export function systemFontOptionGroups(families: readonly SystemFontFamily[]): {
	page: FontOption[];
	monospace: FontOption[];
} {
	const seen = new Set<string>();
	const unique: SystemFontFamily[] = [];
	for (const item of families) {
		const family = item.family.trim();
		const key = family.toLowerCase();
		if (!key || seen.has(key) || BUNDLED_FONT_FAMILIES.has(key)) continue;
		seen.add(key);
		unique.push({ family, monospace: item.monospace });
	}
	// The nsh engine has no `Intl.Collator`: compare case-insensitively by hand.
	unique.sort((a, b) => {
		const left = a.family.toLowerCase();
		const right = b.family.toLowerCase();
		return left < right ? -1 : left > right ? 1 : 0;
	});
	return {
		page: systemFontOptions(
			unique
				.map((item) => item.family)
				.filter((family) => !SYMBOL_FONT_FAMILY_PATTERN.test(family)),
		),
		monospace: systemFontOptions(
			unique.filter((item) => item.monospace).map((item) => item.family),
		),
	};
}

export const DEFAULT_UI_FONT_SIZE: UiFontSize = 15;

export const DEFAULT_PAGE_FONT_FAMILY: PageFontFamily = "inter";
export const DEFAULT_READING_FONT_SIZE: ReadingFontSize = 16;
export const DEFAULT_READING_FONT_FAMILY: PageFontFamily =
	DEFAULT_PAGE_FONT_FAMILY;
export const DEFAULT_CODE_FONT_FAMILY: MonospaceFontFamily = "jetbrains-mono";
export const DEFAULT_CODE_FONT_SIZE: CodeFontSize = 14;
export const DEFAULT_TERMINAL_FONT_FAMILY: MonospaceFontFamily =
	"jetbrains-mono";
export const DEFAULT_TERMINAL_FONT_SIZE: TerminalFontSize = 14;

export {
	getMonospaceFontFamilyStack,
	getPageFontFamilyStack,
} from "./font-stacks";

/** 历史版本保存的候选 slug 到真实字体族名的映射。 */
const LEGACY_PAGE_FONT_FAMILIES: Record<string, string> = {
	"microsoft-yahei": "Microsoft YaHei",
	"segoe-ui": "Segoe UI",
	arial: "Arial",
	"pingfang-sc": "PingFang SC",
	"helvetica-neue": "Helvetica Neue",
	roboto: "Roboto",
	"noto-sans": "Noto Sans",
	"noto-sans-sc": "Noto Sans SC",
	"harmonyos-sans": "HarmonyOS Sans SC",
	"source-han-sans-sc": "Source Han Sans SC",
};

const LEGACY_MONOSPACE_FONT_FAMILIES: Record<string, string> = {
	consolas: "Consolas",
	"cascadia-code": "Cascadia Code",
	"cascadia-mono": "Cascadia Mono",
	"fira-code": "Fira Code",
	"maple-mono": "Maple Mono",
	"sarasa-mono-sc": "Sarasa Mono SC",
	"sf-mono": "SF Mono",
	menlo: "Menlo",
	monaco: "Monaco",
	"source-code-pro": "Source Code Pro",
	"ibm-plex-mono": "IBM Plex Mono",
	iosevka: "Iosevka",
	hack: "Hack",
};

/**
 * 校验并迁移存储的字体值：空值回退默认，历史 slug 映射为字体族名，
 * 其余非空字符串原样接受（浏览器对未知 family 会自行回退）。
 */
function normalizeFontValue<TValue extends string>(
	value: unknown,
	legacyFamilies: Record<string, string>,
	fallback: TValue,
): TValue {
	if (typeof value !== "string" || value.trim().length === 0) {
		return fallback;
	}
	return (legacyFamilies[value] ?? value) as TValue;
}

const MAX_LEGACY_CUSTOM_FONT_LENGTH = 360;
const GENERIC_FONT_KEYWORDS =
	/^(serif|sans-serif|monospace|system-ui|ui-sans-serif|ui-monospace)$/i;

/**
 * 历史版本的“自定义字体列表”输入框值：旧实现把自定义列表渲染在
 * 候选字体之前（优先级最高），因此取第一个有效族名作为新版选择值。
 */
export function legacyCustomFontFamilyValue(
	value: unknown,
	fallback: unknown,
): string {
	const fallbackFamily = typeof fallback === "string" ? fallback : "";
	if (typeof value !== "string") return fallbackFamily;
	const first = value
		.split(",")[0]
		?.trim()
		.replace(/^["']|["']$/g, "")
		.trim();
	if (
		!first ||
		first.length > MAX_LEGACY_CUSTOM_FONT_LENGTH ||
		GENERIC_FONT_KEYWORDS.test(first)
	) {
		return fallbackFamily;
	}
	return first;
}

export function normalizePageFontFamily(
	value: unknown,
	fallback: PageFontFamily,
): PageFontFamily {
	return normalizeFontValue(value, LEGACY_PAGE_FONT_FAMILIES, fallback);
}

export function normalizeMonospaceFontFamily(
	value: unknown,
	fallback: MonospaceFontFamily,
): MonospaceFontFamily {
	return normalizeFontValue(value, LEGACY_MONOSPACE_FONT_FAMILIES, fallback);
}

/** Font sizes have no upper or lower limit beyond being a positive number. */
function isFontSize(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isUiFontSize(value: unknown): value is UiFontSize {
	return isFontSize(value);
}

export function isReadingFontSize(value: unknown): value is ReadingFontSize {
	return isFontSize(value);
}

export function isCodeFontSize(value: unknown): value is CodeFontSize {
	return isFontSize(value);
}

export function isTerminalFontSize(value: unknown): value is TerminalFontSize {
	return isFontSize(value);
}
