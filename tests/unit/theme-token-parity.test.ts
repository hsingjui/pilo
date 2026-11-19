import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	createThemeTokenCatalog,
	parseThemeColor,
	validateCustomThemeTokens,
} from "../../src/lib/theme-tokens.ts";

const [header, ...cases] = readFileSync(
	new URL("../fixtures/theme-token-cases.jsonl", import.meta.url),
	"utf8",
)
	.trimEnd()
	.split("\n")
	.map((line) => JSON.parse(line));
const base = JSON.parse(
	readFileSync(new URL("../../desktop/theme.json", import.meta.url), "utf8"),
);
test("theme token fixture matches the TypeScript source of truth", () => {
	const catalog = createThemeTokenCatalog(base.cssVars);
	assert.deepEqual(Object.fromEntries(catalog), header.catalog);
	for (const entry of cases) {
		if (!("name" in entry)) {
			assert.equal(
				parseThemeColor(entry.input) ?? null,
				entry.expected,
				entry.input,
			);
			continue;
		}
		assert.deepEqual(
			validateCustomThemeTokens(entry.input, catalog),
			entry.expected,
			entry.name,
		);
	}
});
