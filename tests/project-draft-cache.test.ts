import assert from "node:assert/strict";
import test from "node:test";

import { createProjectDraftCache } from "../src/components/app/chat-ui-state-cache.ts";

test("scopes drafts per project and drops empty values", () => {
	const cache = createProjectDraftCache();
	assert.equal(cache.get("p1"), "");
	cache.set("p1", "hello");
	cache.set("p2", "world");
	assert.equal(cache.get("p1"), "hello");
	assert.equal(cache.get("p2"), "world");
	cache.set("p1", "");
	assert.equal(cache.get("p1"), "");
	assert.equal(cache.get("p2"), "world");
});
