import type { AppLocale } from "@/i18n/locale-types";
import type {
	CodeFontSize,
	MonospaceFontFamily,
	PageFontFamily,
	ReadingFontSize,
	TerminalFontSize,
	UiFontSize,
} from "./font-settings-types";
import type { KeyboardShortcutMap } from "./keyboard-shortcuts-types";

export type SendMessageShortcut = "enter" | "mod-enter";

export type PiloPreferences = {
	defaultWorkspaceVisibility: Record<string, boolean>;
	sendMessageShortcut: SendMessageShortcut;
	keyboardShortcuts: KeyboardShortcutMap;
	collapseCompletedActivity: boolean;
	collapseLongMessages: boolean;
	showWorkDuration: boolean;
	showPluginNotifications: boolean;
	desktopNotifications: boolean;
	developerMode: boolean;
	pageFontFamily: PageFontFamily;
	uiFontSize: UiFontSize;
	readingFontFamily: PageFontFamily;
	readingFontSize: ReadingFontSize;
	codeFontFamily: MonospaceFontFamily;
	codeFontSize: CodeFontSize;
	terminalFontFamily: MonospaceFontFamily;
	terminalFontSize: TerminalFontSize;
};

export type HostPreferenceValues = PiloPreferences & { locale: AppLocale };
export type PreferencesSnapshot = {
	revision: number;
	values: HostPreferenceValues;
};
export type PreferencePatch = Partial<
	Omit<HostPreferenceValues, "keyboardShortcuts">
> & { keyboardShortcuts?: Partial<PiloPreferences["keyboardShortcuts"]> };
