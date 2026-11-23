import type { AppLocale } from "./locale-types.ts";
import enUS from "./resources/en-US.ts";
import zhCN from "./resources/zh-CN.ts";

type Messages = { readonly [key: string]: string | Messages };
type MessageKey<T> = {
	[K in keyof T & string]: T[K] extends string
		? K extends `${infer Base}_${"zero" | "one" | "other"}`
			? K | Base
			: K
		: `${K}.${MessageKey<T[K]>}`;
}[keyof T & string];
type Values = Readonly<
	Record<string, string | number | boolean | null | undefined>
>;

function lookup(messages: Messages, key: string): string | undefined {
	let message: string | Messages | undefined = messages;
	for (const part of key.split(".")) {
		if (typeof message !== "object" || !Object.hasOwn(message, part)) return;
		message = message[part];
	}
	return typeof message === "string" ? message : undefined;
}

export function createTranslator<const English extends Messages>(resources: {
	"en-US": English;
	"zh-CN": Messages;
}) {
	return (
		locale: AppLocale,
		key: MessageKey<English>,
		values?: Values,
	): string => {
		function resolve(language: AppLocale) {
			const messages = resources[language];
			const count = values?.count;
			if (typeof count === "number") {
				const category =
					language === "en-US" && Math.abs(count) === 1 ? "one" : "other";
				const zero = count === 0 ? lookup(messages, `${key}_zero`) : undefined;
				return (
					zero ??
					lookup(messages, `${key}_${category}`) ??
					lookup(messages, key)
				);
			}
			return lookup(messages, key);
		}

		const message =
			resolve(locale) ??
			(locale === "zh-CN" ? resolve("en-US") : undefined) ??
			key;
		if (!values) return message;
		return message.replace(
			/\{\{\s*(\w+)\s*\}\}/g,
			(placeholder, name: string) =>
				Object.hasOwn(values, name) ? String(values[name] ?? "") : placeholder,
		);
	};
}

const translate = createTranslator({ "en-US": enUS, "zh-CN": zhCN });
let currentLocale: AppLocale = "en-US";

export function setTranslationLocale(locale: AppLocale): void {
	currentLocale = locale;
}

export function t(key: MessageKey<typeof enUS>, values?: Values): string {
	return translate(currentLocale, key, values);
}
