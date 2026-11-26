import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DEFAULT_WEB_FONT_SCALE,
	parseWebFontScale,
	resolveWebFontMetrics,
	WEB_MIN_INPUT_FONT_SIZE,
	webInputFontSize,
} from "../../shared/web-font-scale.ts";

describe("web-font-scale", () => {
	it("parses valid presets and rejects invalid values", () => {
		assert.equal(parseWebFontScale("small"), "small");
		assert.equal(parseWebFontScale("default"), "default");
		assert.equal(parseWebFontScale("large"), "large");
		assert.equal(parseWebFontScale("medium"), null);
		assert.equal(parseWebFontScale(""), null);
		assert.equal(parseWebFontScale(null), null);
		assert.equal(parseWebFontScale(undefined), null);
		assert.equal(parseWebFontScale(16), null);
	});

	it("resolves monotonically increasing UI, reading, and code sizes across presets", () => {
		const small = resolveWebFontMetrics("small");
		const standard = resolveWebFontMetrics(DEFAULT_WEB_FONT_SCALE);
		const large = resolveWebFontMetrics("large");

		assert.equal(small.uiTextScale, 1);
		assert.equal(small.readingFontSize, 14);
		assert.equal(small.codeFontSize, 12);

		assert.equal(standard.uiTextScale, 16 / 14);
		assert.equal(standard.readingFontSize, 16);
		assert.equal(standard.codeFontSize, 14);

		assert.equal(large.uiTextScale, 18 / 14);
		assert.equal(large.readingFontSize, 18);
		assert.equal(large.codeFontSize, 15);

		assert.ok(small.uiTextScale < standard.uiTextScale);
		assert.ok(standard.uiTextScale < large.uiTextScale);
		assert.ok(small.readingFontSize < standard.readingFontSize);
		assert.ok(standard.readingFontSize < large.readingFontSize);
		assert.ok(small.codeFontSize < standard.codeFontSize);
		assert.ok(standard.codeFontSize < large.codeFontSize);
	});

	it("clamps mobile input font size to at least 16px to avoid iOS focus zoom", () => {
		assert.equal(webInputFontSize(12), WEB_MIN_INPUT_FONT_SIZE);
		assert.equal(webInputFontSize(14), WEB_MIN_INPUT_FONT_SIZE);
		assert.equal(webInputFontSize(16), 16);
		assert.equal(webInputFontSize(18), 18);
		assert.equal(webInputFontSize(Number.NaN), WEB_MIN_INPUT_FONT_SIZE);
	});
});
