import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import {
	isAppLocale,
	persistLocale,
	updateDocumentLocale,
	type AppLocale,
} from "./locale.ts";
import enUS from "./resources/en-US.ts";
import zhCN from "./resources/zh-CN.ts";

export const defaultNS = "translation";

export const resources = {
	"en-US": { translation: enUS },
	"zh-CN": { translation: zhCN },
} as const;

let initialized = false;

export async function initializeI18n(locale: AppLocale): Promise<void> {
	if (initialized) {
		updateDocumentLocale(locale);
		if (i18n.language !== locale) await i18n.changeLanguage(locale);
		return;
	}
	await i18n.use(initReactI18next).init({
		resources,
		lng: locale,
		fallbackLng: "en-US",
		defaultNS,
		ns: [defaultNS],
		returnNull: false,
		interpolation: { escapeValue: false },
	});
	initialized = true;
	updateDocumentLocale(locale);
}

export async function changeAppLocale(locale: AppLocale): Promise<void> {
	if (!isAppLocale(locale)) return;
	persistLocale(locale);
	await i18n.changeLanguage(locale);
	updateDocumentLocale(locale);
}

export { i18n };
export * from "./locale.ts";
