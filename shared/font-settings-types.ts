/**
 * 字体值：内置标识（随应用打包或系统回退，始终可用）或 DirectWrite
 * 枚举出的系统字体族名（直接作为 CSS family 使用）。
 */
export type PageFontFamily = "inter" | "system-sans" | (string & {});
export type MonospaceFontFamily =
	| "jetbrains-mono"
	| "system-mono"
	| (string & {});

export type UiFontSize = number;
export type ReadingFontSize = number;
export type CodeFontSize = number;
export type TerminalFontSize = number;
