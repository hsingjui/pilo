export const APP_LOCALES = ["zh-CN", "en-US"] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const LOCALE_STORAGE_KEY = "pilo.locale";

export function isAppLocale(value: unknown): value is AppLocale {
	return value === "zh-CN" || value === "en-US";
}

export function resolveInitialLocale(
	storedLocale: unknown,
	systemLanguage: string | undefined,
): AppLocale {
	if (isAppLocale(storedLocale)) return storedLocale;
	return systemLanguage?.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function readStoredLocale(storage?: Pick<Storage, "getItem">): unknown {
	if (storage) {
		try {
			return storage.getItem(LOCALE_STORAGE_KEY);
		} catch {
			return null;
		}
	}
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage.getItem(LOCALE_STORAGE_KEY);
	} catch {
		return null;
	}
}

export function persistLocale(
	locale: AppLocale,
	storage?: Pick<Storage, "setItem">,
): void {
	try {
		(storage ?? window.localStorage).setItem(LOCALE_STORAGE_KEY, locale);
	} catch {
		// Restricted webviews may not expose writable storage; the current session still switches.
	}
}

export function updateDocumentLocale(locale: AppLocale): void {
	if (typeof document !== "undefined") {
		document.documentElement.lang = locale;
	}
}
