import i18n from "i18next";
import { writeHostPreferences } from "@/lib/host-preferences";
import { initReactI18next } from "react-i18next";

import { isAppLocale, updateDocumentLocale, type AppLocale } from "./locale.ts";
import { i18nInitOptions } from "./options.ts";

export { defaultNS, resources } from "./options.ts";

let initialized = false;

export async function initializeI18n(locale: AppLocale): Promise<void> {
	if (initialized) {
		updateDocumentLocale(locale);
		if (i18n.language !== locale) await i18n.changeLanguage(locale);
		return;
	}
	await i18n.use(initReactI18next).init(i18nInitOptions(locale));
	initialized = true;
	updateDocumentLocale(locale);
}

export async function changeAppLocale(locale: AppLocale): Promise<void> {
	if (!isAppLocale(locale)) return;
	await writeHostPreferences({ locale });
}

export { i18n };
export * from "./locale.ts";
