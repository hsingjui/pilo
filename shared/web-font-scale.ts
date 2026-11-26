import {
	DEFAULT_CODE_FONT_SIZE,
	DEFAULT_READING_FONT_SIZE,
} from "./font-settings";

export type WebFontScalePreset = "small" | "default" | "large";

export const DEFAULT_WEB_FONT_SCALE: WebFontScalePreset = "default";

/** Minimum input font size on mobile browsers to prevent iOS Safari auto-zoom on focus. */
export const WEB_MIN_INPUT_FONT_SIZE = 16;

export interface WebFontMetrics {
	/** Multiplier applied to `--pilo-ui-text-*` base tokens (base `sm` = 14px). */
	uiTextScale: number;
	/** Chat reading body font size in CSS pixels. */
	readingFontSize: number;
	/** Chat inline code and code block font size in CSS pixels. */
	codeFontSize: number;
}

const WEB_FONT_METRICS: Record<WebFontScalePreset, WebFontMetrics> = {
	small: {
		uiTextScale: 14 / 14,
		readingFontSize: 14,
		codeFontSize: 12,
	},
	default: {
		uiTextScale: 16 / 14,
		readingFontSize: DEFAULT_READING_FONT_SIZE,
		codeFontSize: DEFAULT_CODE_FONT_SIZE,
	},
	large: {
		uiTextScale: 18 / 14,
		readingFontSize: 18,
		codeFontSize: 15,
	},
};

export function parseWebFontScale(value: unknown): WebFontScalePreset | null {
	return value === "small" || value === "default" || value === "large"
		? value
		: null;
}

export function resolveWebFontMetrics(
	preset: WebFontScalePreset,
): WebFontMetrics {
	return WEB_FONT_METRICS[preset];
}

/** Clamps mobile text input sizes to at least 16px to avoid iOS Safari focus zoom. */
export function webInputFontSize(size: number): number {
	return Number.isFinite(size)
		? Math.max(WEB_MIN_INPUT_FONT_SIZE, size)
		: WEB_MIN_INPUT_FONT_SIZE;
}
