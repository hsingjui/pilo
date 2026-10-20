import assert from "node:assert/strict";
import test from "node:test";

import { findMessageMatches } from "../../src/lib/chat/chat-message-search.ts";
import type { ChatMessage } from "../../src/lib/chat/conversation-types.ts";
import {
	sessionMentionValue,
	type SessionMention,
} from "../../src/lib/chat/session-mentions.ts";

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

test("user skill invocation is found through its visible name", () => {
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

test("file references and repeated picks are searched in source order", () => {
	const referenced: ChatMessage[] = [
		{
			id: "file",
			role: "user",
			text: 'Check index.ts.\n@"src/index.ts"\n@"src/index.ts"',
			time: "",
		},
	];
	assert.deepEqual(
		findMessageMatches(referenced, "index.ts").map((match) => [
			match.occurrenceIndex,
			match.start,
		]),
		[
			[0, 6],
			[1, 17],
			[2, 28],
		],
	);
	assert.equal(findMessageMatches(referenced, "src/").length, 0);
	assert.equal(findMessageMatches(referenced, '@"').length, 0);
});

const session: SessionMention = {
	connectionId: "local",
	projectId: "pilo",
	path: "/sessions/previous.jsonl",
	title: "Previous index.ts",
	projectName: "Pilo",
	updatedAt: 1,
};
const sessions = new Map([[sessionMentionValue(session.path), session]]);

test("mixed references search session titles in rendered order within their scope", () => {
	const referenced: ChatMessage[] = [
		{
			id: "mixed",
			role: "user",
			text: `Check index.ts.\n${sessionMentionValue(session.path)}\n@"src/index.ts"`,
			time: "",
		},
	];
	assert.deepEqual(
		findMessageMatches(referenced, "index.ts", sessions).map(
			(match) => match.start,
		),
		[6, 26, 37],
	);
	assert.equal(findMessageMatches(referenced, "Previous", sessions).length, 1);
	assert.equal(
		findMessageMatches(referenced, session.path, sessions).length,
		0,
	);
	// A missing/out-of-scope session is ordinary visible text, not a chip.
	assert.equal(findMessageMatches(referenced, session.path).length, 1);
});

test("Skill instructions project references without exposing the expanded Skill body", () => {
	for (const prefix of [
		"/skill:review ",
		'<skill name="review" location="/skills/review/SKILL.md">\nHidden Skill content\n</skill>\n',
	]) {
		const referenced: ChatMessage[] = [
			{
				id: "skill",
				role: "user",
				text: `${prefix}Check index.ts.\n@"src/index.ts"`,
				time: "",
			},
		];
		assert.deepEqual(
			findMessageMatches(referenced, "index.ts").map((match) => match.start),
			[13, 24],
		);
		assert.equal(findMessageMatches(referenced, "Hidden Skill").length, 0);
		assert.equal(findMessageMatches(referenced, "src/").length, 0);
	}
});
