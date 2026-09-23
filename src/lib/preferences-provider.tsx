import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react";

import {
	DEFAULT_CODE_FONT_FAMILY,
	DEFAULT_CODE_FONT_SIZE,
	DEFAULT_PAGE_FONT_FAMILY,
	DEFAULT_PAGE_FONT_SIZE,
	DEFAULT_TERMINAL_FONT_FAMILY,
	DEFAULT_TERMINAL_FONT_SIZE,
	PAGE_FONT_SIZE_SCALE_BASE,
	getMonospaceFontFamilyStack,
	getPageFontFamilyStack,
	isCodeFontSize,
	isPageFontSize,
	isTerminalFontSize,
	legacyCustomFontFamilyValue,
	normalizeMonospaceFontFamily,
	normalizePageFontFamily,
	type CodeFontSize,
	type MonospaceFontFamily,
	type PageFontFamily,
	type PageFontSize,
	type TerminalFontSize,
} from "@/lib/font-settings";
import {
	DEFAULT_KEYBOARD_SHORTCUTS,
	normalizeKeyboardShortcut,
	normalizeKeyboardShortcutMap,
	type KeyboardShortcutMap,
	type ShortcutCommandId,
} from "@/lib/keyboard-shortcuts";

export type SendMessageShortcut = "enter" | "mod-enter";

export type PiloPreferences = {
	sendMessageShortcut: SendMessageShortcut;
	keyboardShortcuts: KeyboardShortcutMap;
	collapseCompletedActivity: boolean;
	collapseLongMessages: boolean;
	showWorkDuration: boolean;
	desktopNotifications: boolean;
	pageFontFamily: PageFontFamily;
	pageFontSize: PageFontSize;
	codeFontFamily: MonospaceFontFamily;
	codeFontSize: CodeFontSize;
	terminalFontFamily: MonospaceFontFamily;
	terminalFontSize: TerminalFontSize;
};

type PreferencesContextValue = PiloPreferences & {
	setSendMessageShortcut: (value: SendMessageShortcut) => void;
	setKeyboardShortcut: (commandId: ShortcutCommandId, value: string) => void;
	resetKeyboardShortcut: (commandId: ShortcutCommandId) => void;
	resetKeyboardShortcuts: () => void;
	setCollapseCompletedActivity: (value: boolean) => void;
	setCollapseLongMessages: (value: boolean) => void;
	setShowWorkDuration: (value: boolean) => void;
	setDesktopNotifications: (value: boolean) => void;
	setPageFontFamily: (value: PageFontFamily) => void;
	setPageFontSize: (value: PageFontSize) => void;
	setCodeFontFamily: (value: MonospaceFontFamily) => void;
	setCodeFontSize: (value: CodeFontSize) => void;
	setTerminalFontFamily: (value: MonospaceFontFamily) => void;
	setTerminalFontSize: (value: TerminalFontSize) => void;
};

type StoredPreferences = Partial<Omit<PiloPreferences, "keyboardShortcuts">> & {
	keyboardShortcuts?: unknown;
	conversationFontSize?: unknown;
	/** 历史版本的“自定义字体列表”输入框值，仅用于迁移。 */
	pageCustomFontFamily?: unknown;
	codeCustomFontFamily?: unknown;
	terminalCustomFontFamily?: unknown;
};

const STORAGE_KEY = "pilo.preferences.v1";

const DEFAULT_PREFERENCES: PiloPreferences = {
	sendMessageShortcut: "enter",
	keyboardShortcuts: { ...DEFAULT_KEYBOARD_SHORTCUTS },
	collapseCompletedActivity: true,
	collapseLongMessages: true,
	showWorkDuration: true,
	desktopNotifications: false,
	pageFontFamily: DEFAULT_PAGE_FONT_FAMILY,
	pageFontSize: DEFAULT_PAGE_FONT_SIZE,
	codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
	codeFontSize: DEFAULT_CODE_FONT_SIZE,
	terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
	terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function readStoredPreferences(): PiloPreferences {
	if (typeof window === "undefined") return DEFAULT_PREFERENCES;

	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULT_PREFERENCES;
		const parsed = JSON.parse(raw) as StoredPreferences;
		const legacyConversationFontSize = isPageFontSize(
			parsed.conversationFontSize,
		)
			? parsed.conversationFontSize
			: DEFAULT_PREFERENCES.pageFontSize;
		return {
			sendMessageShortcut:
				parsed.sendMessageShortcut === "mod-enter"
					? "mod-enter"
					: DEFAULT_PREFERENCES.sendMessageShortcut,
			keyboardShortcuts: normalizeKeyboardShortcutMap(parsed.keyboardShortcuts),
			collapseCompletedActivity:
				typeof parsed.collapseCompletedActivity === "boolean"
					? parsed.collapseCompletedActivity
					: DEFAULT_PREFERENCES.collapseCompletedActivity,
			collapseLongMessages:
				typeof parsed.collapseLongMessages === "boolean"
					? parsed.collapseLongMessages
					: DEFAULT_PREFERENCES.collapseLongMessages,
			showWorkDuration:
				typeof parsed.showWorkDuration === "boolean"
					? parsed.showWorkDuration
					: DEFAULT_PREFERENCES.showWorkDuration,
			desktopNotifications:
				typeof parsed.desktopNotifications === "boolean"
					? parsed.desktopNotifications
					: DEFAULT_PREFERENCES.desktopNotifications,
			pageFontFamily: normalizePageFontFamily(
				legacyCustomFontFamilyValue(
					parsed.pageCustomFontFamily,
					parsed.pageFontFamily,
				),
				DEFAULT_PREFERENCES.pageFontFamily,
			),
			pageFontSize: isPageFontSize(parsed.pageFontSize)
				? parsed.pageFontSize
				: legacyConversationFontSize,
			codeFontFamily: normalizeMonospaceFontFamily(
				legacyCustomFontFamilyValue(
					parsed.codeCustomFontFamily,
					parsed.codeFontFamily,
				),
				DEFAULT_PREFERENCES.codeFontFamily,
			),
			codeFontSize: isCodeFontSize(parsed.codeFontSize)
				? parsed.codeFontSize
				: DEFAULT_PREFERENCES.codeFontSize,
			terminalFontFamily: normalizeMonospaceFontFamily(
				legacyCustomFontFamilyValue(
					parsed.terminalCustomFontFamily,
					parsed.terminalFontFamily,
				),
				DEFAULT_PREFERENCES.terminalFontFamily,
			),
			terminalFontSize: isTerminalFontSize(parsed.terminalFontSize)
				? parsed.terminalFontSize
				: DEFAULT_PREFERENCES.terminalFontSize,
		};
	} catch {
		return DEFAULT_PREFERENCES;
	}
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
	const [preferences, setPreferences] = useState(readStoredPreferences);

	useLayoutEffect(() => {
		const root = document.documentElement;
		root.style.setProperty(
			"--pilo-page-font-family",
			getPageFontFamilyStack(preferences.pageFontFamily),
		);
		root.style.setProperty(
			"--pilo-page-font-size",
			`${preferences.pageFontSize}px`,
		);
		const pageFontScale = preferences.pageFontSize / PAGE_FONT_SIZE_SCALE_BASE;
		for (const [token, defaultSize] of [
			["--text-2xs", 11],
			["--text-xs", 12],
			["--text-sm", 14],
			["--text-base", 16],
			["--text-lg", 18],
			["--text-xl", 20],
			["--text-2xl", 24],
			["--text-3xl", 30],
			["--text-4xl", 36],
		] as const) {
			root.style.setProperty(token, `${defaultSize * pageFontScale}px`);
		}
		root.style.setProperty(
			"--pilo-code-font-family",
			getMonospaceFontFamilyStack(preferences.codeFontFamily),
		);
		root.style.setProperty(
			"--pilo-code-font-size",
			`${preferences.codeFontSize}px`,
		);
	}, [
		preferences.codeFontFamily,
		preferences.codeFontSize,
		preferences.pageFontFamily,
		preferences.pageFontSize,
	]);

	useEffect(() => {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
	}, [preferences]);

	const setSendMessageShortcut = useCallback((value: SendMessageShortcut) => {
		setPreferences((current) => ({ ...current, sendMessageShortcut: value }));
	}, []);
	const setKeyboardShortcut = useCallback(
		(commandId: ShortcutCommandId, value: string) => {
			const normalized = normalizeKeyboardShortcut(value);
			if (!normalized) return;
			setPreferences((current) => ({
				...current,
				keyboardShortcuts: {
					...current.keyboardShortcuts,
					[commandId]: normalized,
				},
			}));
		},
		[],
	);
	const resetKeyboardShortcut = useCallback((commandId: ShortcutCommandId) => {
		setPreferences((current) => ({
			...current,
			keyboardShortcuts: {
				...current.keyboardShortcuts,
				[commandId]: DEFAULT_KEYBOARD_SHORTCUTS[commandId],
			},
		}));
	}, []);
	const resetKeyboardShortcuts = useCallback(() => {
		setPreferences((current) => ({
			...current,
			keyboardShortcuts: { ...DEFAULT_KEYBOARD_SHORTCUTS },
		}));
	}, []);
	const setCollapseCompletedActivity = useCallback((value: boolean) => {
		setPreferences((current) => ({
			...current,
			collapseCompletedActivity: value,
		}));
	}, []);
	const setCollapseLongMessages = useCallback((value: boolean) => {
		setPreferences((current) => ({ ...current, collapseLongMessages: value }));
	}, []);
	const setShowWorkDuration = useCallback((value: boolean) => {
		setPreferences((current) => ({ ...current, showWorkDuration: value }));
	}, []);
	const setDesktopNotifications = useCallback((value: boolean) => {
		setPreferences((current) => ({ ...current, desktopNotifications: value }));
	}, []);
	const setPageFontFamily = useCallback((value: PageFontFamily) => {
		setPreferences((current) => ({ ...current, pageFontFamily: value }));
	}, []);
	const setPageFontSize = useCallback((value: PageFontSize) => {
		setPreferences((current) => ({ ...current, pageFontSize: value }));
	}, []);
	const setCodeFontFamily = useCallback((value: MonospaceFontFamily) => {
		setPreferences((current) => ({ ...current, codeFontFamily: value }));
	}, []);
	const setCodeFontSize = useCallback((value: CodeFontSize) => {
		setPreferences((current) => ({ ...current, codeFontSize: value }));
	}, []);
	const setTerminalFontFamily = useCallback((value: MonospaceFontFamily) => {
		setPreferences((current) => ({ ...current, terminalFontFamily: value }));
	}, []);
	const setTerminalFontSize = useCallback((value: TerminalFontSize) => {
		setPreferences((current) => ({ ...current, terminalFontSize: value }));
	}, []);

	const value = useMemo<PreferencesContextValue>(
		() => ({
			...preferences,
			setSendMessageShortcut,
			setKeyboardShortcut,
			resetKeyboardShortcut,
			resetKeyboardShortcuts,
			setCollapseCompletedActivity,
			setCollapseLongMessages,
			setShowWorkDuration,
			setDesktopNotifications,
			setPageFontFamily,
			setPageFontSize,
			setCodeFontFamily,
			setCodeFontSize,
			setTerminalFontFamily,
			setTerminalFontSize,
		}),
		[
			preferences,
			resetKeyboardShortcut,
			resetKeyboardShortcuts,
			setCodeFontFamily,
			setCodeFontSize,
			setCollapseCompletedActivity,
			setCollapseLongMessages,
			setDesktopNotifications,
			setPageFontFamily,
			setPageFontSize,
			setKeyboardShortcut,
			setSendMessageShortcut,
			setShowWorkDuration,
			setTerminalFontFamily,
			setTerminalFontSize,
		],
	);

	return (
		<PreferencesContext.Provider value={value}>
			{children}
		</PreferencesContext.Provider>
	);
}

export function usePreferences() {
	const context = useContext(PreferencesContext);
	if (!context) {
		throw new Error("usePreferences must be used inside PreferencesProvider");
	}
	return context;
}
