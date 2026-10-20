import assert from "node:assert/strict";
import test from "node:test";

import {
	discardChatFiles,
	discardRemovedChatFiles,
	registerChatFile,
	retainChatFiles,
} from "../../src/lib/chat/chat-file-lifecycle.ts";
import { fileMentionValue } from "../../src/lib/chat/chat-mentions.ts";

const path = "/project/attachments/AAAAAAAAAAAAAAAAAAAAAA/report.txt";

test("removing the final inline reference discards an owned upload once", () => {
	let removed = 0;
	registerChatFile(path, async () => {
		removed += 1;
	});
	const token = fileMentionValue(path);
	const draft = `before ${token} between ${token} after`;
	discardRemovedChatFiles(draft, `before ${token} after`);
	assert.equal(removed, 0);
	discardRemovedChatFiles(`before ${token} after`, "before after");
	discardChatFiles([path]);
	assert.equal(removed, 1);
});

test("inline submissions transfer uploads out of pending cleanup ownership", () => {
	let removed = 0;
	registerChatFile(path, async () => {
		removed += 1;
	});
	retainChatFiles(`/skill:review inspect ${fileMentionValue(path)} now`);
	discardChatFiles([path]);
	assert.equal(removed, 0);
});

test("cleanup never adopts a file from a restored draft", () => {
	assert.doesNotThrow(() =>
		discardRemovedChatFiles(`before ${fileMentionValue(path)} after`, ""),
	);
});
