import type {
	MonospaceFontFamily,
	PageFontFamily,
} from "./font-settings-types";

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
