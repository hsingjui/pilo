import assert from "node:assert/strict";
import test from "node:test";

import {
	isAppLocale,
	resolveInitialLocale,
	LOCALE_STORAGE_KEY,
} from "../src/i18n/locale.ts";

test("accepts only the two supported locales", () => {
	assert.equal(isAppLocale("zh-CN"), true);
	assert.equal(isAppLocale("en-US"), true);
	assert.equal(isAppLocale("zh-TW"), false);
	assert.equal(isAppLocale("system"), false);
});

test("stored valid locale wins over system language", () => {
	assert.equal(resolveInitialLocale("en-US", "zh-CN"), "en-US");
	assert.equal(resolveInitialLocale("zh-CN", "en-US"), "zh-CN");
});

test("Chinese system languages resolve to Simplified Chinese", () => {
	assert.equal(resolveInitialLocale(null, "zh-CN"), "zh-CN");
	assert.equal(resolveInitialLocale(null, "ZH-tw"), "zh-CN");
});

test("non-Chinese and invalid stored locales resolve to English", () => {
	assert.equal(resolveInitialLocale(null, "en-US"), "en-US");
	assert.equal(resolveInitialLocale("system", "fr-FR"), "en-US");
	assert.equal(resolveInitialLocale("zh-TW", "de-DE"), "en-US");
	assert.equal(resolveInitialLocale(null, undefined), "en-US");
});

test("locale storage key stays dedicated from general preferences", () => {
	assert.equal(LOCALE_STORAGE_KEY, "pilo.locale");
});
