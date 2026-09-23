import { invoke } from "@tauri-apps/api/core";

/**
 * 字体值：内置标识（随应用打包或系统回退，始终可用）或 DirectWrite
 * 枚举出的系统字体族名（直接作为 CSS family 使用）。
 */
export type PageFontFamily = "inter" | "system-sans" | (string & {});
export type MonospaceFontFamily =
	| "jetbrains-mono"
	| "system-mono"
	| (string & {});

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

export const PAGE_FONT_SIZES = [12, 14, 16, 18, 20, 22] as const;
export const CODE_FONT_SIZES = [11, 12, 13, 14, 16, 18] as const;
export const TERMINAL_FONT_SIZES = [11, 12, 13, 14, 16, 18] as const;

export type PageFontSize = (typeof PAGE_FONT_SIZES)[number];
export type CodeFontSize = (typeof CODE_FONT_SIZES)[number];
export type TerminalFontSize = (typeof TERMINAL_FONT_SIZES)[number];

export const DEFAULT_PAGE_FONT_FAMILY: PageFontFamily = "inter";
export const DEFAULT_PAGE_FONT_SIZE: PageFontSize = 16;
export const PAGE_FONT_SIZE_SCALE_BASE = 14;
export const DEFAULT_CODE_FONT_FAMILY: MonospaceFontFamily = "jetbrains-mono";
export const DEFAULT_CODE_FONT_SIZE: CodeFontSize = 14;
export const DEFAULT_TERMINAL_FONT_FAMILY: MonospaceFontFamily =
	"jetbrains-mono";
export const DEFAULT_TERMINAL_FONT_SIZE: TerminalFontSize = 14;

const PAGE_FONT_FALLBACK_STACK =
	'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Helvetica Neue", Arial, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
const MONOSPACE_FONT_FALLBACK_STACK =
	'ui-monospace, "SF Mono", "Cascadia Mono", "Consolas", "Microsoft YaHei", "Noto Sans SC", monospace';

const PAGE_FONT_BUILTIN_STACKS: Record<"inter" | "system-sans", string> = {
	inter: `"Inter", ${PAGE_FONT_FALLBACK_STACK}`,
	"system-sans": PAGE_FONT_FALLBACK_STACK,
};

const MONOSPACE_FONT_BUILTIN_STACKS: Record<
	"jetbrains-mono" | "system-mono",
	string
> = {
	"jetbrains-mono":
		'"JetBrains Mono", ui-monospace, "SF Mono", "SFMono-Regular", "Monaco", "Menlo", "Consolas", "Liberation Mono", "Courier New", monospace',
	"system-mono":
		'ui-monospace, "SF Mono", "SFMono-Regular", "Monaco", "Menlo", "Consolas", "Liberation Mono", "Courier New", monospace',
};

function quoteFontFamily(family: string): string {
	return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function getPageFontFamilyStack(value: PageFontFamily): string {
	// `(string & {})` 成员会让字面量收窄失效，命中内置分支后需断言索引。
	if (value === "inter" || value === "system-sans") {
		return PAGE_FONT_BUILTIN_STACKS[value as "inter" | "system-sans"];
	}
	return `${quoteFontFamily(value)}, ${PAGE_FONT_FALLBACK_STACK}`;
}

export function getMonospaceFontFamilyStack(
	value: MonospaceFontFamily,
): string {
	if (value === "jetbrains-mono" || value === "system-mono") {
		return MONOSPACE_FONT_BUILTIN_STACKS[
			value as "jetbrains-mono" | "system-mono"
		];
	}
	return `${quoteFontFamily(value)}, ${MONOSPACE_FONT_FALLBACK_STACK}`;
}

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

export function isPageFontSize(value: unknown): value is PageFontSize {
	return PAGE_FONT_SIZES.some((size) => size === value);
}

export function isCodeFontSize(value: unknown): value is CodeFontSize {
	return CODE_FONT_SIZES.some((size) => size === value);
}

export function isTerminalFontSize(value: unknown): value is TerminalFontSize {
	return TERMINAL_FONT_SIZES.some((size) => size === value);
}

let systemFontFamiliesPromise: Promise<readonly string[]> | null = null;
let systemMonospaceFamiliesPromise: Promise<readonly string[]> | null = null;

/**
 * 全量枚举系统已安装字体族。整个会话只查询一次并缓存；
 * 枚举失败时回退为空列表，下拉退化为仅内置候选。
 */
export function resolveSystemFontFamilies(): Promise<readonly string[]> {
	if (!systemFontFamiliesPromise) {
		systemFontFamiliesPromise = invoke<string[]>("system_font_families")
			.then((families) => dedupeAndSortFontFamilies(families))
			.catch((error) => {
				console.warn("system_font_families failed", error);
				// 清空缓存允许下次打开设置时重试，避免首帧失败被永久缓存。
				systemFontFamiliesPromise = null;
				systemMonospaceFamiliesPromise = null;
				return [];
			});
	}
	return systemFontFamiliesPromise;
}

/** 过滤出等宽的系统字体族，同样会话内只计算一次。 */
export function resolveSystemMonospaceFamilies(): Promise<readonly string[]> {
	if (!systemMonospaceFamiliesPromise) {
		systemMonospaceFamiliesPromise = resolveSystemFontFamilies().then(
			(families) => filterMonospaceFamilies(families),
		);
	}
	return systemMonospaceFamiliesPromise;
}

const FONT_FAMILY_COLLATOR = new Intl.Collator("en", { sensitivity: "base" });

/**
 * 大小写不敏感地按名称排序并去重。tsconfig 的 lib 目标还不含
 * `Array#toSorted`，`sort` 又会原地突变，因此对副本排序。
 */
function dedupeAndSortFontFamilies(families: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const family of families) {
		const trimmed = family.trim();
		const key = trimmed.toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(trimmed);
	}
	const sorted = [...result];
	sorted.sort((a, b) => FONT_FAMILY_COLLATOR.compare(a, b));
	return sorted;
}

const FONT_PROBE_SIZE = 48;
const FONT_PROBE_EPSILON = 0.5;

/**
 * 测量窄字符、宽字符与数字的 advance，全部一致才视为等宽字体。
 * 候选来自系统枚举、必然已安装，不存在回退误判。
 */
function filterMonospaceFamilies(families: readonly string[]): string[] {
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");
	if (!ctx) return [...families];
	const measure = (family: string, text: string) => {
		ctx.font = `${FONT_PROBE_SIZE}px ${quoteFontFamily(family)}, monospace`;
		return ctx.measureText(text).width;
	};
	return families.filter((family) => {
		const narrow = measure(family, "iiiiiiiiii");
		const wide = measure(family, "WWWWWWWWWW");
		const digits = measure(family, "1111111111");
		return (
			Math.abs(narrow - wide) < FONT_PROBE_EPSILON &&
			Math.abs(narrow - digits) < FONT_PROBE_EPSILON
		);
	});
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
