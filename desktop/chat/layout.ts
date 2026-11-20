import { DEFAULT_UI_FONT_SIZE } from "@/lib/font-settings";

/** Tauri's default root size, for matching rem-based chat geometry in points. */
export const DEFAULT_CHAT_REM = (16 * DEFAULT_UI_FONT_SIZE) / 14;

/** Convert the React chat's Tailwind spacing and type scale to points. */
export const chatPx = (px: number) => (px * DEFAULT_CHAT_REM) / 16;
export const chatMetadataText = {
	fontSize: chatPx(11),
	lineHeight: chatPx(16.5),
};
