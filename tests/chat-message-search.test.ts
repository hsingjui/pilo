import assert from "node:assert/strict";
import test from "node:test";

import { findMessageMatches } from "../src/lib/chat-message-search.ts";
import type { ChatMessage } from "../src/lib/conversation-types.ts";

const messages: ChatMessage[] = [
	{ id: "u1", role: "user", text: "Hello **World**", time: "" },
	{ id: "a1", role: "assistant", text: "no hit here", time: "" },
	{ id: "a2", role: "assistant", text: "again hello", time: "" },
	{
		id: "u2",
		role: "user",
		text: "placeholder",
		time: "",
		historyPlaceholder: true,
	},
];

test("empty query returns no matches", () => {
	assert.deepEqual(findMessageMatches(messages, "   "), []);
});

test("matches case-insensitively and reports message index", () => {
	assert.deepEqual(
		findMessageMatches(messages, "hello").map((match) => [
			match.messageId,
			match.messageIndex,
		]),
		[
			["u1", 0],
			["a2", 2],
		],
	);
});

test("search text keeps markdown so assistant replies stay searchable", () => {
	const [first] = findMessageMatches(messages, "world");
	assert.ok(first);
	assert.equal(first.snippet.includes("**World**"), true);
});

test("assistant code fences are searchable", () => {
	const code: ChatMessage[] = [
		{
			id: "a1",
			role: "assistant",
			text: "```ts\nconst needle = 1\n```",
			time: "",
		},
	];
	assert.equal(findMessageMatches(code, "needle").length, 1);
});

test("every occurrence in a message is reported separately", () => {
	const repeated: ChatMessage[] = [
		{ id: "a1", role: "assistant", text: "foo bar foo baz foo", time: "" },
	];
	assert.deepEqual(
		findMessageMatches(repeated, "foo").map((match) => [
			match.occurrenceIndex,
			match.start,
		]),
		[
			[0, 0],
			[1, 8],
			[2, 16],
		],
	);
});

test("history placeholders are skipped", () => {
	assert.deepEqual(findMessageMatches(messages, "placeholder"), []);
});

test("user skill invocation is found through its /skill:name summary", () => {
	const skillText = [
		'<skill name="animate" location="/root/.agents/skills/animate/SKILL.md">',
		"# Animate",
		"Build an animation from scratch.",
		"</skill>",
	].join("\n");
	const matches = findMessageMatches(
		[{ id: "s1", role: "user", text: skillText, time: "" }],
		"animate",
	);
	assert.equal(matches.length, 1);
});
