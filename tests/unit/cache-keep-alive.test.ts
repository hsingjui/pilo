import assert from "node:assert/strict";
import test from "node:test";

import { cacheKeepAliveHitRate } from "../../shared/cache-keep-alive.ts";

test("keep-alive cache hit rate includes uncached input and cache writes", () => {
	assert.equal(
		cacheKeepAliveHitRate({
			inputTokens: 200,
			cacheReadTokens: 700,
			cacheWriteTokens: 100,
		}),
		0.7,
	);
	assert.equal(
		cacheKeepAliveHitRate({
			inputTokens: 0,
			cacheReadTokens: 1000,
			cacheWriteTokens: 0,
		}),
		1,
	);
	assert.equal(
		cacheKeepAliveHitRate({
			inputTokens: 200,
			cacheReadTokens: 0,
			cacheWriteTokens: 100,
		}),
		0,
	);
});

test("keep-alive cache hit rate is unknown for missing usage or empty input", () => {
	for (const inputTokens of [undefined, null, 0]) {
		assert.equal(
			cacheKeepAliveHitRate({
				inputTokens,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			}),
			null,
		);
	}
	assert.equal(
		cacheKeepAliveHitRate({ cacheReadTokens: 1000, cacheWriteTokens: 0 }),
		null,
	);
});
