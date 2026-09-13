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
	getMonospaceFontFamilyStack,
	getPageFontFamilyStack,
	isCodeFontSize,
	isMonospaceFontFamily,
	isPageFontFamily,
	isPageFontSize,
	isTerminalFontSize,
	normalizeCustomFontFamily,
	type CodeFontSize,
	type MonospaceFontFamily,
	type PageFontFamily,
	type PageFontSize,
	type TerminalFontSize,
} from "@/lib/font-settings";

export type SendMessageShortcut = "enter" | "mod-enter";

export type PiloPreferences = {
	sendMessageShortcut: SendMessageShortcut;
	collapseCompletedActivity: boolean;
	showWorkDuration: boolean;
	desktopNotifications: boolean;
	pageFontFamily: PageFontFamily;
	pageCustomFontFamily: string;
	pageFontSize: PageFontSize;
	codeFontFamily: MonospaceFontFamily;
	codeCustomFontFamily: string;
	codeFontSize: CodeFontSize;
	terminalFontFamily: MonospaceFontFamily;
	terminalCustomFontFamily: string;
	terminalFontSize: TerminalFontSize;
};

type PreferencesContextValue = PiloPreferences & {
	setSendMessageShortcut: (value: SendMessageShortcut) => void;
	setCollapseCompletedActivity: (value: boolean) => void;
	setShowWorkDuration: (value: boolean) => void;
	setDesktopNotifications: (value: boolean) => void;
	setPageFontFamily: (value: PageFontFamily) => void;
	setPageCustomFontFamily: (value: string) => void;
	setPageFontSize: (value: PageFontSize) => void;
	setCodeFontFamily: (value: MonospaceFontFamily) => void;
	setCodeCustomFontFamily: (value: string) => void;
	setCodeFontSize: (value: CodeFontSize) => void;
	setTerminalFontFamily: (value: MonospaceFontFamily) => void;
	setTerminalCustomFontFamily: (value: string) => void;
	setTerminalFontSize: (value: TerminalFontSize) => void;
};

type StoredPreferences = Partial<PiloPreferences> & {
	conversationFontSize?: unknown;
};

const STORAGE_KEY = "pilo.preferences.v1";

const DEFAULT_PREFERENCES: PiloPreferences = {
	sendMessageShortcut: "enter",
	collapseCompletedActivity: true,
	showWorkDuration: true,
	desktopNotifications: false,
	pageFontFamily: DEFAULT_PAGE_FONT_FAMILY,
	pageCustomFontFamily: "",
	pageFontSize: DEFAULT_PAGE_FONT_SIZE,
	codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
	codeCustomFontFamily: "",
	codeFontSize: DEFAULT_CODE_FONT_SIZE,
	terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
	terminalCustomFontFamily: "",
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
			collapseCompletedActivity:
				typeof parsed.collapseCompletedActivity === "boolean"
					? parsed.collapseCompletedActivity
					: DEFAULT_PREFERENCES.collapseCompletedActivity,
			showWorkDuration:
				typeof parsed.showWorkDuration === "boolean"
					? parsed.showWorkDuration
					: DEFAULT_PREFERENCES.showWorkDuration,
			desktopNotifications:
				typeof parsed.desktopNotifications === "boolean"
					? parsed.desktopNotifications
					: DEFAULT_PREFERENCES.desktopNotifications,
			pageFontFamily: isPageFontFamily(parsed.pageFontFamily)
				? parsed.pageFontFamily
				: DEFAULT_PREFERENCES.pageFontFamily,
			pageCustomFontFamily: normalizeCustomFontFamily(
				parsed.pageCustomFontFamily,
			),
			pageFontSize: isPageFontSize(parsed.pageFontSize)
				? parsed.pageFontSize
				: legacyConversationFontSize,
			codeFontFamily: isMonospaceFontFamily(parsed.codeFontFamily)
				? parsed.codeFontFamily
				: DEFAULT_PREFERENCES.codeFontFamily,
			codeCustomFontFamily: normalizeCustomFontFamily(
				parsed.codeCustomFontFamily,
			),
			codeFontSize: isCodeFontSize(parsed.codeFontSize)
				? parsed.codeFontSize
				: DEFAULT_PREFERENCES.codeFontSize,
			terminalFontFamily: isMonospaceFontFamily(parsed.terminalFontFamily)
				? parsed.terminalFontFamily
				: DEFAULT_PREFERENCES.terminalFontFamily,
			terminalCustomFontFamily: normalizeCustomFontFamily(
				parsed.terminalCustomFontFamily,
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
			getPageFontFamilyStack(
				preferences.pageFontFamily,
				preferences.pageCustomFontFamily,
			),
		);
		root.style.setProperty(
			"--pilo-page-font-size",
			`${preferences.pageFontSize}px`,
		);
		const pageFontScale = preferences.pageFontSize / DEFAULT_PAGE_FONT_SIZE;
		for (const [token, defaultSize] of [
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
			getMonospaceFontFamilyStack(
				preferences.codeFontFamily,
				preferences.codeCustomFontFamily,
			),
		);
		root.style.setProperty(
			"--pilo-code-font-size",
			`${preferences.codeFontSize}px`,
		);
	}, [
		preferences.codeFontFamily,
		preferences.codeCustomFontFamily,
		preferences.codeFontSize,
		preferences.pageFontFamily,
		preferences.pageCustomFontFamily,
		preferences.pageFontSize,
	]);

	useEffect(() => {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
	}, [preferences]);

	const setSendMessageShortcut = useCallback((value: SendMessageShortcut) => {
		setPreferences((current) => ({ ...current, sendMessageShortcut: value }));
	}, []);
	const setCollapseCompletedActivity = useCallback((value: boolean) => {
		setPreferences((current) => ({
			...current,
			collapseCompletedActivity: value,
		}));
	}, []);
	const setShowWorkDuration = useCallback((value: boolean) => {
		setPreferences((current) => ({ ...current, showWorkDuration: value }));
	}, []);
	const setDesktopNotifications = useCallback((value: boolean) => {
		setPreferences((current) => ({ ...current, desktopNotifications: value }));
	}, []);
	const setPageFontFamily = useCallback((value: PageFontFamily) => {
		setPreferences((current) => ({
			...current,
			pageFontFamily: value,
			pageCustomFontFamily: "",
		}));
	}, []);
	const setPageCustomFontFamily = useCallback((value: string) => {
		setPreferences((current) => ({
			...current,
			pageCustomFontFamily: normalizeCustomFontFamily(value),
		}));
	}, []);
	const setPageFontSize = useCallback((value: PageFontSize) => {
		setPreferences((current) => ({ ...current, pageFontSize: value }));
	}, []);
	const setCodeFontFamily = useCallback((value: MonospaceFontFamily) => {
		setPreferences((current) => ({
			...current,
			codeFontFamily: value,
			codeCustomFontFamily: "",
		}));
	}, []);
	const setCodeCustomFontFamily = useCallback((value: string) => {
		setPreferences((current) => ({
			...current,
			codeCustomFontFamily: normalizeCustomFontFamily(value),
		}));
	}, []);
	const setCodeFontSize = useCallback((value: CodeFontSize) => {
		setPreferences((current) => ({ ...current, codeFontSize: value }));
	}, []);
	const setTerminalFontFamily = useCallback((value: MonospaceFontFamily) => {
		setPreferences((current) => ({
			...current,
			terminalFontFamily: value,
			terminalCustomFontFamily: "",
		}));
	}, []);
	const setTerminalCustomFontFamily = useCallback((value: string) => {
		setPreferences((current) => ({
			...current,
			terminalCustomFontFamily: normalizeCustomFontFamily(value),
		}));
	}, []);
	const setTerminalFontSize = useCallback((value: TerminalFontSize) => {
		setPreferences((current) => ({ ...current, terminalFontSize: value }));
	}, []);

	const value = useMemo<PreferencesContextValue>(
		() => ({
			...preferences,
			setSendMessageShortcut,
			setCollapseCompletedActivity,
			setShowWorkDuration,
			setDesktopNotifications,
			setPageFontFamily,
			setPageCustomFontFamily,
			setPageFontSize,
			setCodeFontFamily,
			setCodeCustomFontFamily,
			setCodeFontSize,
			setTerminalFontFamily,
			setTerminalCustomFontFamily,
			setTerminalFontSize,
		}),
		[
			preferences,
			setCodeFontFamily,
			setCodeCustomFontFamily,
			setCodeFontSize,
			setCollapseCompletedActivity,
			setDesktopNotifications,
			setPageFontFamily,
			setPageCustomFontFamily,
			setPageFontSize,
			setSendMessageShortcut,
			setShowWorkDuration,
			setTerminalFontFamily,
			setTerminalCustomFontFamily,
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
