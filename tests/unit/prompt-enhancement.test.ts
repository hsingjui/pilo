import assert from "node:assert/strict";
import test from "node:test";

import { promptEnhancementModel } from "../../src/lib/prompt-enhancement.ts";

test("prompt enhancement follows the selected chat model", () => {
	assert.deepEqual(
		promptEnhancementModel({ provider: " openai ", id: " gpt-5.6 " }),
		{ provider: "openai", id: "gpt-5.6" },
	);
});

test("prompt enhancement follows nothing without a complete model", () => {
	assert.equal(promptEnhancementModel(null), null);
	assert.equal(promptEnhancementModel(undefined), null);
	assert.equal(promptEnhancementModel({ provider: "", id: "gpt-5.6" }), null);
	assert.equal(promptEnhancementModel({ provider: "openai", id: "   " }), null);
});
