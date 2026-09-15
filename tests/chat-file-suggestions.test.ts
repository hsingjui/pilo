import assert from "node:assert/strict";
import test from "node:test";

import { createFileSuggestions } from "../src/components/chat/chat-file-suggestions.ts";

test("file suggestions show files for an empty @ query", () => {
	const suggestions = createFileSuggestions(
		["src/z.ts", "README.md", "src/a.ts", "docs/guide.md", "a.txt", "b.txt"],
		"",
	);

	assert.equal(suggestions.length, 5);
	assert.deepEqual(
		suggestions.map((suggestion) => suggestion.value),
		["@src/z.ts", "@README.md", "@src/a.ts", "@docs/guide.md", "@a.txt"],
	);
});

test("file suggestions rank filename matches and quote paths with spaces", () => {
	const suggestions = createFileSuggestions(
		[
			"docs/chat composer.md",
			"src/chat.ts",
			"src/chat-composer.ts",
			"notes/other.md",
		],
		"chat",
	);

	assert.deepEqual(
		suggestions.map((suggestion) => suggestion.value),
		["@src/chat.ts", "@src/chat-composer.ts", '@"docs/chat composer.md"'],
	);
});
