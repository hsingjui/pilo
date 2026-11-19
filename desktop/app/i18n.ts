import type { TFunction } from "i18next";
import { locale as systemLocale, signal } from "nsh";
import { setLocale } from "nsh/i18n";

import { i18n } from "@/i18n/instance";
import { resolveInitialLocale, type AppLocale } from "@/i18n/locale-types.ts";
import { i18nInitOptions } from "@/i18n/options.ts";

const shownLocale = signal<AppLocale>("en-US");

/** The language the app shows (reactive). */
export const appLocale = (): AppLocale => shownLocale();

/**
 * Starts the shared i18next instance from Pilo's resource objects in the
 * stored locale, else the system's, and returns the locale it shows.
 */
export function initializeI18n(storedLocale?: unknown): AppLocale {
	const locale = resolveInitialLocale(storedLocale, systemLocale());
	if (i18n.isInitialized) {
		void i18n.changeLanguage(locale);
	} else {
		void i18n.init({ ...i18nInitOptions(locale), initAsync: false });
	}
	show(locale);
	return locale;
}

export async function setAppLocale(locale: AppLocale): Promise<void> {
	await i18n.changeLanguage(locale);
	show(locale);
}

/** i18next's `t`, read again by the views that show it when the locale changes. */
export const t = ((...args: Parameters<TFunction>) => {
	shownLocale();
	return Reflect.apply(i18n.t, i18n, args);
}) as TFunction;

function show(locale: AppLocale) {
	setLocale(locale);
	shownLocale.set(locale);
}
