import assert from "node:assert/strict";
import test from "node:test";

import {
	appendChatInputHistory,
	isChatInputHistoryCursorValid,
	moveChatInputHistory,
	readChatInputHistory,
} from "../src/lib/chat-input-history.ts";

const entries = ["first", "/compact", "third"];

test("history navigation starts from the newest entry and walks older", () => {
	const newest = moveChatInputHistory(entries, null, "older");
	assert.deepEqual(newest, { handled: true, cursor: 2, value: "third" });

	const command = moveChatInputHistory(entries, newest.cursor, "older");
	assert.deepEqual(command, { handled: true, cursor: 1, value: "/compact" });

	const oldest = moveChatInputHistory(entries, command.cursor, "older");
	assert.deepEqual(oldest, { handled: true, cursor: 0, value: "first" });

	assert.deepEqual(
		moveChatInputHistory(entries, oldest.cursor, "older"),
		oldest,
	);
});

test("history navigation walks newer and returns to an empty draft", () => {
	const newer = moveChatInputHistory(entries, 0, "newer");
	assert.deepEqual(newer, { handled: true, cursor: 1, value: "/compact" });

	const newest = moveChatInputHistory(entries, newer.cursor, "newer");
	assert.deepEqual(newest, { handled: true, cursor: 2, value: "third" });

	assert.deepEqual(moveChatInputHistory(entries, newest.cursor, "newer"), {
		handled: true,
		cursor: null,
		value: "",
	});
});

test("down does not start history navigation from an empty draft", () => {
	assert.deepEqual(moveChatInputHistory(entries, null, "newer"), {
		handled: false,
		cursor: null,
		value: "",
	});
});

test("history cursor becomes invalid when the controlled draft changes externally", () => {
	assert.equal(isChatInputHistoryCursorValid(entries, 2, "third"), true);
	assert.equal(
		isChatInputHistoryCursorValid(entries, 2, "restored external draft"),
		false,
	);
	assert.equal(isChatInputHistoryCursorValid(entries, null, "anything"), true);
});

test("stored history stays isolated by project and skips adjacent duplicates", () => {
	const storage = new Map<string, string>();
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			localStorage: {
				getItem: (key: string) => storage.get(key) ?? null,
				setItem: (key: string, value: string) => storage.set(key, value),
			},
		},
	});

	try {
		appendChatInputHistory("project-a", "hello");
		appendChatInputHistory("project-a", "/compact");
		appendChatInputHistory("project-a", "/compact");
		appendChatInputHistory("project-b", "other");

		assert.deepEqual(readChatInputHistory("project-a"), ["hello", "/compact"]);
		assert.deepEqual(readChatInputHistory("project-b"), ["other"]);
	} finally {
		if (originalWindow) {
			Object.defineProperty(globalThis, "window", originalWindow);
		} else {
			Reflect.deleteProperty(globalThis, "window");
		}
	}
});
