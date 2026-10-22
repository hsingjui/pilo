import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";

import {
	DEFAULT_CODE_FONT_FAMILY,
	DEFAULT_CODE_FONT_SIZE,
	DEFAULT_PAGE_FONT_FAMILY,
	DEFAULT_UI_FONT_SIZE,
	DEFAULT_READING_FONT_SIZE,
	DEFAULT_TERMINAL_FONT_FAMILY,
	DEFAULT_TERMINAL_FONT_SIZE,
	DEFAULT_READING_FONT_FAMILY,
	getMonospaceFontFamilyStack,
	getPageFontFamilyStack,
	isCodeFontSize,
	isUiFontSize,
	isReadingFontSize,
	isTerminalFontSize,
	legacyCustomFontFamilyValue,
	normalizeMonospaceFontFamily,
	normalizePageFontFamily,
	type CodeFontSize,
	type MonospaceFontFamily,
	type PageFontFamily,
	type ReadingFontSize,
	type TerminalFontSize,
	type UiFontSize,
} from "@/lib/font-settings";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
	i18n,
	initializeI18n,
	persistLocale,
	updateDocumentLocale,
} from "@/i18n";
import { listenRuntimeEvents } from "@/lib/api/pi-runtime";
import { CONFIGURATION_CHANGED_EVENT } from "@/lib/use-configuration-revision";
import { notifyConnectionsChanged } from "@/lib/api/connection-events";
import {
	bindHostPreferences,
	publishHostPreferences,
	refreshHostPreferences,
	subscribeHostPreferences,
	writeHostPreferences,
	type PreferencePatch,
	type PreferencesSnapshot,
} from "@/lib/host-preferences";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { useDeveloperTools } from "@/lib/use-developer-tools";
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

type PreferencesContextValue = PiloPreferences & {
	setSendMessageShortcut: (value: SendMessageShortcut) => void;
	setKeyboardShortcut: (commandId: ShortcutCommandId, value: string) => void;
	resetKeyboardShortcut: (commandId: ShortcutCommandId) => void;
	resetKeyboardShortcuts: () => void;
	setCollapseCompletedActivity: (value: boolean) => void;
	setCollapseLongMessages: (value: boolean) => void;
	setShowWorkDuration: (value: boolean) => void;
	setShowPluginNotifications: (value: boolean) => void;
	setDesktopNotifications: (value: boolean) => void;
	setDeveloperMode: (value: boolean) => void;
	setPageFontFamily: (value: PageFontFamily) => void;
	setUiFontSize: (value: UiFontSize) => void;
	setReadingFontFamily: (value: PageFontFamily) => void;
	setReadingFontSize: (value: ReadingFontSize) => void;
	resetFontFamilies: () => void;
	resetFontSizes: () => void;
	setCodeFontFamily: (value: MonospaceFontFamily) => void;
	setCodeFontSize: (value: CodeFontSize) => void;
	setTerminalFontFamily: (value: MonospaceFontFamily) => void;
	setTerminalFontSize: (value: TerminalFontSize) => void;
};

type StoredPreferences = Partial<Omit<PiloPreferences, "keyboardShortcuts">> & {
	keyboardShortcuts?: unknown;
	pageFontSize?: unknown;
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
	showPluginNotifications: false,
	desktopNotifications: false,
	developerMode: false,
	pageFontFamily: DEFAULT_PAGE_FONT_FAMILY,
	uiFontSize: DEFAULT_UI_FONT_SIZE,
	readingFontFamily: DEFAULT_READING_FONT_FAMILY,
	readingFontSize: DEFAULT_READING_FONT_SIZE,
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
		const legacyReadingFontSize = isReadingFontSize(parsed.pageFontSize)
			? parsed.pageFontSize
			: isReadingFontSize(parsed.conversationFontSize)
				? parsed.conversationFontSize
				: DEFAULT_PREFERENCES.readingFontSize;
		const pageFontFamily = normalizePageFontFamily(
			legacyCustomFontFamilyValue(
				parsed.pageCustomFontFamily,
				parsed.pageFontFamily,
			),
			DEFAULT_PREFERENCES.pageFontFamily,
		);
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
			showPluginNotifications:
				typeof parsed.showPluginNotifications === "boolean"
					? parsed.showPluginNotifications
					: DEFAULT_PREFERENCES.showPluginNotifications,
			desktopNotifications:
				typeof parsed.desktopNotifications === "boolean"
					? parsed.desktopNotifications
					: DEFAULT_PREFERENCES.desktopNotifications,
			developerMode: parsed.developerMode === true,
			pageFontFamily,
			uiFontSize: isUiFontSize(parsed.uiFontSize)
				? parsed.uiFontSize
				: DEFAULT_PREFERENCES.uiFontSize,
			readingFontFamily: normalizePageFontFamily(
				parsed.readingFontFamily,
				pageFontFamily,
			),
			readingFontSize: isReadingFontSize(parsed.readingFontSize)
				? parsed.readingFontSize
				: legacyReadingFontSize,
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
	const [preferences, applyPreferences] = useState(readStoredPreferences);
	const preferencesRef = useRef(preferences);
	const hostValuesRef = useRef(preferences);
	const pendingRef = useRef<PreferencePatch[]>([]);
	const applyCurrentPreferences = useCallback(() => {
		const next = { ...hostValuesRef.current };
		for (const patch of pendingRef.current) {
			const keyboardShortcuts = {
				...next.keyboardShortcuts,
				...patch.keyboardShortcuts,
			};
			Object.assign(next, patch, { keyboardShortcuts });
		}
		preferencesRef.current = next;
		applyPreferences(next);
	}, []);
	const revisionRef = useRef({ binding: -1, revision: -1 });
	const localeQueueRef = useRef<Promise<void>>(Promise.resolve());
	const initialRef = useRef({
		...preferences,
		locale: i18n.language === "zh-CN" ? "zh-CN" : "en-US",
	});
	useEffect(
		() =>
			subscribeHostPreferences((snapshot, binding) => {
				const previous = revisionRef.current;
				if (
					binding === previous.binding &&
					snapshot.revision < previous.revision
				)
					return;
				revisionRef.current = { binding, revision: snapshot.revision };
				const { locale, ...next } = snapshot.values;
				hostValuesRef.current = next;
				applyCurrentPreferences();
				persistLocale(locale);
				updateDocumentLocale(locale);
				localeQueueRef.current = localeQueueRef.current
					.catch(() => {})
					.then(() => initializeI18n(locale));
				void localeQueueRef.current.catch((error: unknown) =>
					console.warn("Failed to apply Host locale", error),
				);
			}),
		[applyCurrentPreferences],
	);

	useEffect(() => {
		if (!isTauri()) return;
		try {
			for (const key of [STORAGE_KEY, LOCALE_STORAGE_KEY]) {
				const legacy = window.localStorage.getItem(key);
				if (
					legacy !== null &&
					window.localStorage.getItem(`${key}.legacy`) === null
				) {
					window.localStorage.setItem(`${key}.legacy`, legacy);
				}
			}
		} catch {
			/* Migration can proceed without a writable browser cache. */
		}
		let disposed = false;
		let unlisten: (() => void) | undefined;
		const listening = listenRuntimeEvents((event) => {
			if (disposed) return;
			if (event.type === "preferences_changed")
				publishHostPreferences(event.settings);
			if (event.type === "configuration_changed") {
				notifyConnectionsChanged();
				window.dispatchEvent(new Event(CONFIGURATION_CHANGED_EVENT));
			}
		}).then((cleanup) => {
			if (disposed) cleanup();
			else unlisten = cleanup;
		});
		const connection = bindHostPreferences(
			{
				load: () => invoke<PreferencesSnapshot>("preferences_get"),
				patch: (patch) =>
					invoke<PreferencesSnapshot>("preferences_patch", { patch }),
			},
			async () => {
				await listening;
				return invoke<PreferencesSnapshot>("preferences_patch", {
					patch: initialRef.current,
					initial: true,
				});
			},
		);
		void connection.ready.catch((error: unknown) =>
			toast.error(i18n.t("settings.preferencesLoadFailed"), {
				description: String(error),
			}),
		);
		const visible = () => {
			if (document.visibilityState === "visible")
				void refreshHostPreferences().catch((error: unknown) =>
					console.warn("Failed to refresh Host preferences", error),
				);
		};
		document.addEventListener("visibilitychange", visible);
		return () => {
			disposed = true;
			unlisten?.();
			connection.dispose();
			document.removeEventListener("visibilitychange", visible);
		};
	}, []);

	const setPreferences = useCallback(
		(update: (current: PiloPreferences) => PiloPreferences) => {
			const current = preferencesRef.current;
			const next = update(current);
			const patch: PreferencePatch = {};
			for (const key of Object.keys(next) as (keyof PiloPreferences)[]) {
				if (JSON.stringify(current[key]) !== JSON.stringify(next[key]))
					Object.assign(patch, { [key]: next[key] });
			}
			if (patch.keyboardShortcuts) {
				const changes = Object.fromEntries(
					Object.entries(patch.keyboardShortcuts).filter(
						([key, value]) =>
							current.keyboardShortcuts[key as ShortcutCommandId] !== value,
					),
				);
				Object.assign(patch, { keyboardShortcuts: changes });
			}
			if (Object.keys(patch).length === 0) return;
			pendingRef.current.push(patch);
			applyCurrentPreferences();
			const settle = () => {
				pendingRef.current = pendingRef.current.filter(
					(pending) => pending !== patch,
				);
				applyCurrentPreferences();
			};
			void writeHostPreferences(patch).then(settle, (error: unknown) => {
				settle();
				toast.error(i18n.t("settings.preferencesSaveFailed"), {
					description: String(error),
				});
			});
		},
		[applyCurrentPreferences],
	);
	useDeveloperTools(preferences.developerMode, preferences.keyboardShortcuts);

	useLayoutEffect(() => {
		const root = document.documentElement;
		// Tailwind text-sm is 14px at 100%; keep this base independent of the default size.
		root.style.fontSize = `${(preferences.uiFontSize / 14) * 100}%`;
		root.style.setProperty(
			"--pilo-page-font-family",
			getPageFontFamilyStack(preferences.pageFontFamily),
		);
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
		preferences.uiFontSize,
	]);

	useEffect(() => {
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
		} catch {
			/* Host remains authoritative. */
		}
	}, [preferences]);

	const setSendMessageShortcut = useCallback(
		(value: SendMessageShortcut) => {
			setPreferences((current) => ({ ...current, sendMessageShortcut: value }));
		},
		[setPreferences],
	);
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
		[setPreferences],
	);
	const resetKeyboardShortcut = useCallback(
		(commandId: ShortcutCommandId) => {
			setPreferences((current) => ({
				...current,
				keyboardShortcuts: {
					...current.keyboardShortcuts,
					[commandId]: DEFAULT_KEYBOARD_SHORTCUTS[commandId],
				},
			}));
		},
		[setPreferences],
	);
	const resetKeyboardShortcuts = useCallback(() => {
		setPreferences((current) => ({
			...current,
			keyboardShortcuts: { ...DEFAULT_KEYBOARD_SHORTCUTS },
		}));
	}, [setPreferences]);
	const setCollapseCompletedActivity = useCallback(
		(value: boolean) => {
			setPreferences((current) => ({
				...current,
				collapseCompletedActivity: value,
			}));
		},
		[setPreferences],
	);
	const setCollapseLongMessages = useCallback(
		(value: boolean) => {
			setPreferences((current) => ({
				...current,
				collapseLongMessages: value,
			}));
		},
		[setPreferences],
	);
	const setShowWorkDuration = useCallback(
		(value: boolean) => {
			setPreferences((current) => ({ ...current, showWorkDuration: value }));
		},
		[setPreferences],
	);
	const setShowPluginNotifications = useCallback(
		(value: boolean) => {
			setPreferences((current) => ({
				...current,
				showPluginNotifications: value,
			}));
		},
		[setPreferences],
	);
	const setDesktopNotifications = useCallback(
		(value: boolean) => {
			setPreferences((current) => ({
				...current,
				desktopNotifications: value,
			}));
		},
		[setPreferences],
	);
	const setDeveloperMode = useCallback(
		(value: boolean) => {
			setPreferences((current) => ({ ...current, developerMode: value }));
		},
		[setPreferences],
	);
	const setPageFontFamily = useCallback(
		(value: PageFontFamily) => {
			setPreferences((current) => ({ ...current, pageFontFamily: value }));
		},
		[setPreferences],
	);
	const setUiFontSize = useCallback(
		(value: UiFontSize) => {
			if (!isUiFontSize(value)) return;
			setPreferences((current) => ({ ...current, uiFontSize: value }));
		},
		[setPreferences],
	);
	const setReadingFontFamily = useCallback(
		(value: PageFontFamily) => {
			setPreferences((current) => ({ ...current, readingFontFamily: value }));
		},
		[setPreferences],
	);
	const setReadingFontSize = useCallback(
		(value: ReadingFontSize) => {
			if (!isReadingFontSize(value)) return;
			setPreferences((current) => ({ ...current, readingFontSize: value }));
		},
		[setPreferences],
	);
	const resetFontFamilies = useCallback(() => {
		setPreferences((current) => ({
			...current,
			pageFontFamily: DEFAULT_PAGE_FONT_FAMILY,
			readingFontFamily: DEFAULT_READING_FONT_FAMILY,
			codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
			terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
		}));
	}, [setPreferences]);
	const resetFontSizes = useCallback(() => {
		setPreferences((current) => ({
			...current,
			uiFontSize: DEFAULT_UI_FONT_SIZE,
			readingFontSize: DEFAULT_READING_FONT_SIZE,
			codeFontSize: DEFAULT_CODE_FONT_SIZE,
			terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
		}));
	}, [setPreferences]);
	const setCodeFontFamily = useCallback(
		(value: MonospaceFontFamily) => {
			setPreferences((current) => ({ ...current, codeFontFamily: value }));
		},
		[setPreferences],
	);
	const setCodeFontSize = useCallback(
		(value: CodeFontSize) => {
			if (!isCodeFontSize(value)) return;
			setPreferences((current) => ({ ...current, codeFontSize: value }));
		},
		[setPreferences],
	);
	const setTerminalFontFamily = useCallback(
		(value: MonospaceFontFamily) => {
			setPreferences((current) => ({ ...current, terminalFontFamily: value }));
		},
		[setPreferences],
	);
	const setTerminalFontSize = useCallback(
		(value: TerminalFontSize) => {
			if (!isTerminalFontSize(value)) return;
			setPreferences((current) => ({ ...current, terminalFontSize: value }));
		},
		[setPreferences],
	);
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
			setShowPluginNotifications,
			setDesktopNotifications,
			setDeveloperMode,
			setPageFontFamily,
			setUiFontSize,
			setReadingFontFamily,
			setReadingFontSize,
			resetFontFamilies,
			resetFontSizes,
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
			setDeveloperMode,
			setPageFontFamily,
			setUiFontSize,
			setReadingFontFamily,
			setReadingFontSize,
			resetFontFamilies,
			resetFontSizes,
			setKeyboardShortcut,
			setSendMessageShortcut,
			setShowWorkDuration,
			setShowPluginNotifications,
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
