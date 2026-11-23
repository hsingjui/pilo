import { locale as systemLocale, signal } from "nsh";
import { setLocale } from "nsh/i18n";

import {
	resolveInitialLocale,
	type AppLocale,
} from "@shared/i18n/locale-types.ts";
import {
	setTranslationLocale,
	t as translate,
} from "@shared/i18n/translate.ts";

const shownLocale = signal<AppLocale>("en-US");

/** The language the app shows (reactive). */
export const appLocale = (): AppLocale => shownLocale();

/** Uses the stored locale if supported, otherwise the system locale. */
export function initializeI18n(storedLocale?: unknown): AppLocale {
	const locale = resolveInitialLocale(storedLocale, systemLocale());
	setAppLocale(locale);
	return locale;
}

export function setAppLocale(locale: AppLocale): void {
	setTranslationLocale(locale);
	setLocale(locale);
	shownLocale.set(locale);
}

/** Reads the locale signal so translated views update when it changes. */
export function t(...args: Parameters<typeof translate>): string {
	shownLocale();
	return translate(...args);
}
