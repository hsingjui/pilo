import type { InitOptions } from "i18next";

import type { AppLocale } from "./locale-types.ts";
import enUS from "./resources/en-US.ts";
import zhCN from "./resources/zh-CN.ts";

export const defaultNS = "translation";

export const resources = {
	"en-US": { translation: enUS },
	"zh-CN": { translation: zhCN },
} as const;

/** i18next options shared by the React app and the nsh desktop app. */
export function i18nInitOptions(locale: AppLocale): InitOptions {
	return {
		resources,
		lng: locale,
		fallbackLng: "en-US",
		defaultNS,
		ns: [defaultNS],
		returnNull: false,
		interpolation: { escapeValue: false },
	};
}
