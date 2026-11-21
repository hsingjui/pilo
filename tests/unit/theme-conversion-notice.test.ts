import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeConversionNotice } from "../../web/components/settings/theme-conversion-notice.tsx";
import type {
	ThemeCustomConversion,
	ThemeConversionIssue,
} from "../../shared/theme-settings-types.ts";
import { i18n, initializeI18n } from "../../web/i18n/index.ts";

await initializeI18n("en-US");

const reasons: ThemeConversionIssue["reason"][] = [
	"unsupported-at-rule",
	"unsupported-selector",
	"malformed",
	"not-custom-property",
	"unknown-token",
	"unsupported-value",
	"invalid-value",
	"appearance-not-allowed",
];
const conversion: ThemeCustomConversion = {
	current: reasons.map((reason) => ({
		kind: "declaration",
		reason,
		selector: ":root > .example",
		text: "--example: <original>;",
	})),
	savedThemes: [
		{
			name: "Saved",
			issues: [
				{
					kind: "rule",
					reason: "unsupported-at-rule",
					text: "@media print { body { color: red; } }",
				},
			],
		},
	],
};
const render = (props: Parameters<typeof ThemeConversionNotice>[0]) =>
	renderToStaticMarkup(createElement(ThemeConversionNotice, props));

test("conversion notice is absent for missing, empty, and unrelated saved issues", () => {
	assert.equal(render({}), "");
	assert.equal(render({ conversion: { current: [], savedThemes: [] } }), "");
	assert.equal(render({ conversion, savedThemeName: "Missing" }), "");
});

test("duplicate diagnostics remain visible in a keyboard-focusable wrapping region", () => {
	const issue = conversion.current[0];
	const html = render({
		conversion: { current: [issue, issue], savedThemes: [] },
	});
	assert.equal((html.match(/<li /g) ?? []).length, 2);
	assert.match(html, /tabindex="0"/);
	assert.match(html, /aria-label="Unconverted CSS details"/);
	assert.match(html, /whitespace-pre-wrap \[overflow-wrap:anywhere\]/);
	assert.doesNotMatch(html, /break-all/);
});

test("conversion notice selects the source theme and renders read-only escaped CSS with localized reasons", async () => {
	try {
		const checkLocale = async (locale: "en-US" | "zh-CN") => {
			await initializeI18n(locale);
			const html = render({ conversion });
			assert.ok(
				html.includes(i18n.t("settings.themeConversionTitle", { count: 8 })),
			);
			assert.ok(
				html.includes(
					i18n.t("settings.themeConversionHint").replaceAll("'", "&#x27;"),
				),
			);
			for (const reason of reasons)
				assert.ok(
					html.includes(i18n.t(`settings.themeConversionReasons.${reason}`)),
				);
			assert.match(html, /:root &gt; .example/);
			assert.match(html, /--example: &lt;original&gt;;/);
			assert.doesNotMatch(html, /<input|<textarea|contenteditable/i);
			const saved = render({ conversion, savedThemeName: "Saved" });
			assert.match(saved, /@media print/);
			assert.doesNotMatch(saved, /--example/);
		};
		await checkLocale("en-US");
		await checkLocale("zh-CN");
	} finally {
		await initializeI18n("en-US");
	}
});
