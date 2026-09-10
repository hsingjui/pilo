import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react";

export type SendMessageShortcut = "enter" | "mod-enter";
export type ConversationFontSize = 13 | 14 | 15 | 16;

export type PiloPreferences = {
	sendMessageShortcut: SendMessageShortcut;
	collapseCompletedActivity: boolean;
	showWorkDuration: boolean;
	desktopNotifications: boolean;
	conversationFontSize: ConversationFontSize;
};

type PreferencesContextValue = PiloPreferences & {
	setSendMessageShortcut: (value: SendMessageShortcut) => void;
	setCollapseCompletedActivity: (value: boolean) => void;
	setShowWorkDuration: (value: boolean) => void;
	setDesktopNotifications: (value: boolean) => void;
	setConversationFontSize: (value: ConversationFontSize) => void;
};

const STORAGE_KEY = "pilo.preferences.v1";

const DEFAULT_PREFERENCES: PiloPreferences = {
	sendMessageShortcut: "enter",
	collapseCompletedActivity: true,
	showWorkDuration: true,
	desktopNotifications: false,
	conversationFontSize: 14,
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function isConversationFontSize(value: unknown): value is ConversationFontSize {
	return value === 13 || value === 14 || value === 15 || value === 16;
}

function readStoredPreferences(): PiloPreferences {
	if (typeof window === "undefined") return DEFAULT_PREFERENCES;

	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULT_PREFERENCES;
		const parsed = JSON.parse(raw) as Partial<PiloPreferences>;
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
			conversationFontSize: isConversationFontSize(parsed.conversationFontSize)
				? parsed.conversationFontSize
				: DEFAULT_PREFERENCES.conversationFontSize,
		};
	} catch {
		return DEFAULT_PREFERENCES;
	}
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
	const [preferences, setPreferences] = useState(readStoredPreferences);

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
	const setConversationFontSize = useCallback((value: ConversationFontSize) => {
		setPreferences((current) => ({ ...current, conversationFontSize: value }));
	}, []);

	const value = useMemo<PreferencesContextValue>(
		() => ({
			...preferences,
			setSendMessageShortcut,
			setCollapseCompletedActivity,
			setShowWorkDuration,
			setDesktopNotifications,
			setConversationFontSize,
		}),
		[
			preferences,
			setCollapseCompletedActivity,
			setConversationFontSize,
			setDesktopNotifications,
			setSendMessageShortcut,
			setShowWorkDuration,
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
