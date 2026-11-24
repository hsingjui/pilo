import { type Accessor, context, platform } from "nsh";

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

/**
 * Optical vertical offset (in points) for an icon beside single-line reading
 * text in a flex-centered row. Sans/CJK fonts have more ascent than descent
 * (especially Segoe UI / Microsoft YaHei on Windows), so geometric box
 * centering places icons visibly above the glyphs' optical midline.
 */
export function readingIconOpticalOffset(
	fontSize: number,
	os: string = platform.os,
): number {
	const ratio = os === "windows" ? 0.095 : 0.06;
	return Math.round(fontSize * ratio * 2) / 2;
}

/**
 * Optical alignment style for a leading/trailing icon or inline badge beside
 * reading text.
 */
export function readingIconStyle(
	font: ChatReadingFont,
	os: string = platform.os,
) {
	return {
		transform: [{ translateY: readingIconOpticalOffset(font.fontSize, os) }],
	};
}
