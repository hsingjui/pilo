export const APP_LOCALES = ["zh-CN", "en-US"] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

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
