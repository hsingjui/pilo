import { computed } from "nsh";
import { expect, open, test } from "nsh/test";

import enUS from "@shared/i18n/resources/en-US.ts";
import zhCN from "@shared/i18n/resources/zh-CN.ts";
import { createTranslator } from "@shared/i18n/translate.ts";

import { appLocale, initializeI18n, setAppLocale, t } from "../shell/i18n";

type Messages = { readonly [key: string]: string | Messages };

function placeholders(messages: Messages, prefix = ""): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const [key, value] of Object.entries(messages)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof value === "string") {
			const names = [...value.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(
				(m) => m[1],
			);
			found.set(path, names);
		} else {
			for (const [nested, names] of placeholders(value, path))
				found.set(nested, names);
		}
	}
	return found;
}

test("the shell starts in the system language, falling back to English", async () => {
	const shell = (locale: string) =>
		open("./app-shell-states-fixture.tsx", {
			locale,
			storage: { "fixture.scenario": "starting" },
		});
	const chinese = await shell("zh-Hans-CN");
	await chinese.waitFor("id:workspace >> label:加载中…");
	const english = await shell("en-US");
	await english.waitFor("id:workspace >> label:Loading…");
	const french = await shell("fr-FR");
	await french.waitFor("id:workspace >> label:Loading…");
});

test("switching the locale re-renders interpolated text and moves the nsh locale", async () => {
	const app = await open("./i18n-fixture.tsx", { locale: "en-US" });
	expect(app.shows("text:Locale: en-US / en-US")).toBe(true);
	expect(app.shows("text:Select a project")).toBe(true);
	expect(app.shows("text:Added <b>pilo</b>")).toBe(true);
	expect(app.shows("text:Local · ~/code")).toBe(true);

	await app.press("Use Chinese");
	await app.waitFor("text:Locale: zh-CN / zh-CN");
	expect(app.shows("text:Locale: zh-CN / zh-CN")).toBe(true);
	expect(app.shows("text:选择项目")).toBe(true);
	expect(app.shows("text:已添加 <b>pilo</b>")).toBe(true);

	await app.press("Use English");
	await app.waitFor("text:Locale: en-US / en-US");
	expect(app.shows("text:Locale: en-US / en-US")).toBe(true);
	expect(app.shows("text:Select a project")).toBe(true);
});

test("a stored locale wins over the system one and t follows setAppLocale", () => {
	expect(initializeI18n("zh-CN")).toBe("zh-CN");
	expect(appLocale()).toBe("zh-CN");
	const shown = computed(() => t("app.selectProject"));
	expect(shown()).toBe("选择项目");

	setAppLocale("en-US");
	expect(shown()).toBe("Select a project");

	expect(initializeI18n("de-DE")).toBe("en-US");
	expect(initializeI18n(null)).toBe("en-US");
});

test("plural keys resolve for English and Chinese without Intl.PluralRules", () => {
	const translate = createTranslator({
		"en-US": { files_one: "{{count}} file", files_other: "{{count}} files" },
		"zh-CN": { files_other: "{{count}} 个文件" },
	});
	expect(translate("en-US", "files", { count: 1 })).toBe("1 file");
	expect(translate("en-US", "files", { count: 0 })).toBe("0 files");
	expect(translate("en-US", "files", { count: 2 })).toBe("2 files");
	expect(translate("zh-CN", "files", { count: 1 })).toBe("1 个文件");
	expect(translate("zh-CN", "files", { count: 5 })).toBe("5 个文件");
});

test("missing Chinese messages fall back to English and interpolate literal values", () => {
	const translate = createTranslator({
		"en-US": { project: { added: "Added {{name}} ({{count}})" } },
		"zh-CN": {},
	});
	expect(
		translate("zh-CN", "project.added", { name: "$& {{count}}", count: 0 }),
	).toBe("Added $& {{count}} (0)");
});

test("every English message has a Chinese one that fills only English placeholders", () => {
	const english = placeholders(enUS);
	const chinese = placeholders(zhCN);
	const mismatched = [...english].filter(([key, names]) => {
		const translated = chinese.get(key);
		return !translated || translated.some((name) => !names.includes(name));
	});
	expect(mismatched.map(([key]) => key).join(", ")).toBe("");
	expect(chinese.size).toBe(english.size);
});
