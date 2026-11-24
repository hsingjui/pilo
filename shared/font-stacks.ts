import type {
	MonospaceFontFamily,
	PageFontFamily,
} from "./font-settings-types";

const PAGE_FONT_FALLBACK_STACK =
	'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Helvetica Neue", Arial, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
const MONOSPACE_FONT_FALLBACK_STACK =
	'ui-monospace, "SF Mono", "Cascadia Mono", "Consolas", "Microsoft YaHei", "Noto Sans SC", monospace';

const SYSTEM_MONOSPACE_FONT_STACK =
	'ui-monospace, "SF Mono", "SFMono-Regular", "Monaco", "Menlo", "Consolas", "Liberation Mono", "Courier New", monospace';

function quoteFontFamily(family: string): string {
	return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function getPageFontFamilyStack(value: PageFontFamily): string {
	if (value === "system-sans") return PAGE_FONT_FALLBACK_STACK;
	return `${quoteFontFamily(value)}, ${PAGE_FONT_FALLBACK_STACK}`;
}

export function getMonospaceFontFamilyStack(
	value: MonospaceFontFamily,
): string {
	if (value === "system-mono") return SYSTEM_MONOSPACE_FONT_STACK;
	return `${quoteFontFamily(value)}, ${MONOSPACE_FONT_FALLBACK_STACK}`;
}
