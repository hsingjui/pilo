import { type Accessor, context, signal } from "nsh";

import {
	DEFAULT_READING_FONT_FAMILY,
	DEFAULT_READING_FONT_SIZE,
	getPageFontFamilyStack,
	type PageFontFamily,
} from "@shared/font-settings";

/**
 * The conversation's text (Settings → Fonts → Reading font): replies,
 * prompts and the work rows between them, as the WebUI's message column
 * sets `readingFontSize`/`readingFontFamily` on it.
 */
export interface ChatReadingFont {
	fontSize: number;
	fontFamily: string;
}

export function chatReadingFont(
	values?: {
		readingFontSize?: number;
		readingFontFamily?: PageFontFamily;
	} | null,
): ChatReadingFont {
	return {
		fontSize: values?.readingFontSize ?? DEFAULT_READING_FONT_SIZE,
		fontFamily: getPageFontFamilyStack(
			values?.readingFontFamily ?? DEFAULT_READING_FONT_FAMILY,
		),
	};
}

const defaultChatReadingFont = chatReadingFont();

export const ChatReadingFont = context<Accessor<ChatReadingFont>>(
	() => defaultChatReadingFont,
);

/** The reading text's style; with `lineHeight`, lines that many times its size. */
export function readingTextStyle(font: ChatReadingFont, lineHeight?: number) {
	return lineHeight === undefined
		? { fontSize: font.fontSize, fontFamily: font.fontFamily }
		: {
				fontSize: font.fontSize,
				fontFamily: font.fontFamily,
				lineHeight: font.fontSize * lineHeight,
			};
}

export interface ReadingTextLineMetrics {
	ascender: number;
	descender: number;
	capHeight: number;
}

/**
 * Optical vertical offset (in points) for an icon beside single-line reading
 * text in a flex-centered row, derived from the text's real font metrics.
 *
 * Inside a line box of height `ascender + descender`, geometric centering puts
 * the icon at `(ascender + descender) / 2`, while the glyphs' cap midline sits
 * at `ascender - capHeight / 2`. Symmetric half-leading cancels out, leaving
 * `(ascender - descender - capHeight) / 2`. Balanced fonts (HarmonyOS Sans SC,
 * Microsoft YaHei UI, PingFang SC, SF Pro) naturally yield 0, while top-heavy
 * fonts (Segoe UI, Noto Sans SC) get a small positive nudge.
 */
export function readingIconOpticalOffset(
	metrics?: ReadingTextLineMetrics | null,
): number {
	if (!metrics) return 0;
	const { ascender, capHeight } = metrics;
	const descender = Math.abs(metrics.descender);
	if (
		!Number.isFinite(ascender) ||
		!Number.isFinite(descender) ||
		!Number.isFinite(capHeight) ||
		ascender <= 0 ||
		capHeight <= 0
	) {
		return 0;
	}
	const raw = (ascender - descender - capHeight) / 2;
	const clamped = Math.max(-2, Math.min(2, raw));
	const rounded = Math.round(clamped * 2) / 2;
	return Object.is(rounded, -0) ? 0 : rounded;
}

/** Aligns a row's own icons with its text, including any font fallback. */
export function createReadingIconAlignment() {
	const offset = signal(0);
	return {
		style: () => {
			const translateY = offset();
			return translateY === 0 ? undefined : { transform: [{ translateY }] };
		},
		onTextLayout: (event: { lines: readonly ReadingTextLineMetrics[] }) => {
			offset.set(readingIconOpticalOffset(event.lines[0]));
		},
	};
}
