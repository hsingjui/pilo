import { invoke } from "@tauri-apps/api/core";

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

/** 随应用打包的字体族名（小写）；全量枚举时跳过，避免与内置候选重复。 */
const BUNDLED_FONT_FAMILIES = new Set(["inter", "jetbrains mono"]);

export type FontSizeRange = { min: number; max: number };

export const UI_FONT_SIZE_RANGE: FontSizeRange = { min: 12, max: 18 };
export const READING_FONT_SIZE_RANGE: FontSizeRange = { min: 12, max: 32 };
export const CODE_FONT_SIZE_RANGE: FontSizeRange = { min: 10, max: 24 };
export const TERMINAL_FONT_SIZE_RANGE: FontSizeRange = { min: 10, max: 24 };

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

function isFontSize(value: unknown, range: FontSizeRange): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= range.min &&
		value <= range.max
	);
}

export function isUiFontSize(value: unknown): value is UiFontSize {
	return isFontSize(value, UI_FONT_SIZE_RANGE);
}

export function isReadingFontSize(value: unknown): value is ReadingFontSize {
	return isFontSize(value, READING_FONT_SIZE_RANGE);
}

export function isCodeFontSize(value: unknown): value is CodeFontSize {
	return isFontSize(value, CODE_FONT_SIZE_RANGE);
}

export function isTerminalFontSize(value: unknown): value is TerminalFontSize {
	return isFontSize(value, TERMINAL_FONT_SIZE_RANGE);
}

/** 后端返回的系统字体族及其原生等宽判定。 */
export type SystemFontFamily = {
	family: string;
	monospace: boolean;
};

let systemFontFamiliesPromise: Promise<readonly SystemFontFamily[]> | null =
	null;

/**
 * 全量枚举系统已安装字体族（含原生等宽判定）。整个会话只查询一次并缓存；
 * 枚举失败时回退为空列表，下拉退化为仅内置候选。
 */
function resolveSystemFonts(): Promise<readonly SystemFontFamily[]> {
	if (!systemFontFamiliesPromise) {
		systemFontFamiliesPromise = invoke<SystemFontFamily[]>(
			"system_font_families",
		)
			.then((families) => dedupeAndSortFontFamilies(families))
			.catch((error) => {
				console.warn("system_font_families failed", error);
				// 清空缓存允许下次打开设置时重试，避免首帧失败被永久缓存。
				systemFontFamiliesPromise = null;
				return [];
			});
	}
	return systemFontFamiliesPromise;
}

/** 全部系统字体族名，供页面字体候选使用。 */
export function resolveSystemFontFamilies(): Promise<readonly string[]> {
	return resolveSystemFonts().then((families) =>
		families.map((item) => item.family),
	);
}

/** 依据后端原生等宽判定过滤出的等宽字体族名。 */
export function resolveSystemMonospaceFamilies(): Promise<readonly string[]> {
	return resolveSystemFonts().then((families) =>
		families.filter((item) => item.monospace).map((item) => item.family),
	);
}

const FONT_FAMILY_COLLATOR = new Intl.Collator("en", { sensitivity: "base" });

/**
 * 大小写不敏感地按名称排序并去重。tsconfig 的 lib 目标还不含
 * `Array#toSorted`，`sort` 又会原地突变，因此对副本排序。
 */
function dedupeAndSortFontFamilies(
	families: readonly SystemFontFamily[],
): SystemFontFamily[] {
	const seen = new Set<string>();
	const result: SystemFontFamily[] = [];
	for (const item of families) {
		const family = item.family.trim();
		const key = family.toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push({ family, monospace: item.monospace });
	}
	const sorted = [...result];
	sorted.sort((a, b) => FONT_FAMILY_COLLATOR.compare(a.family, b.family));
	return sorted;
}

/** 系统字体族转下拉选项；跳过与随应用打包字体重名的族，避免重复。 */
export function buildSystemFontOptions(
	systemFamilies: readonly string[],
): FontOption[] {
	const options: FontOption[] = [];
	for (const family of systemFamilies) {
		if (BUNDLED_FONT_FAMILIES.has(family.toLowerCase())) continue;
		options.push({ value: family, label: family, family });
	}
	return options;
}

/**
 * 符号/图标字体（选中后页面文字会变成不可读字形），不进入页面字体候选。
 * 仅用于页面字体列表；等宽列表由 canvas 测量自行过滤。
 */
const SYMBOL_FONT_FAMILY_PATTERN =
	/\b(?:wingdings|webdings|marlett|dingbat|emoji|fluent icons|mdl\d|symbol)/i;

export function filterSymbolFontFamilies(
	families: readonly string[],
): string[] {
	return families.filter((family) => !SYMBOL_FONT_FAMILY_PATTERN.test(family));
}
