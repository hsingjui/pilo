import assert from "node:assert/strict";
import test from "node:test";

import {
	fileMentionPath,
	fileMentionValue,
	readChatMentionDraft,
	readChatMentionParts,
	writeChatMentionDraft,
	type ChatMention,
} from "../../src/lib/chat/chat-mentions.ts";
import { createChatSubmission } from "../../src/lib/chat/chat-submission.ts";
import {
	sessionMentionValue,
	type SessionMention,
} from "../../src/lib/chat/session-mentions.ts";

const session: SessionMention = {
	connectionId: "local",
	projectId: "pilo",
	path: String.raw`C:\Users\Dev User\sessions\session.jsonl`,
	title: "Previous discussion",
	projectName: "Pilo",
	updatedAt: 1,
};
const sessions = new Map([[sessionMentionValue(session.path), session]]);
const file: ChatMention = { kind: "file", path: "src/chat composer.tsx" };
const sessionReference: ChatMention = {
	kind: "session",
	path: session.path,
	session,
};

test("completed file picks stay ordinary quoted Pi paths, including spaces and Unicode", () => {
	for (const path of [
		"README",
		".gitignore",
		"src/index.ts",
		"docs/设计 notes.md",
	]) {
		assert.equal(fileMentionPath(fileMentionValue(path)), path);
		const reference: ChatMention = { kind: "file", path };
		assert.deepEqual(
			readChatMentionDraft(writeChatMentionDraft([reference], ""), sessions),
			{
				references: [reference],
				text: "",
			},
		);
	}
});

test("file and session chips round-trip in either order without changing body text", () => {
	for (const references of [
		[file, sessionReference],
		[sessionReference, file],
	]) {
		const text = "Please check this.\n\nKeep this line. ";
		assert.deepEqual(
			readChatMentionDraft(writeChatMentionDraft(references, text), sessions),
			{
				references,
				text,
			},
		);
	}
});

test("body-start Backspace can remove the last mixed reference atomically", () => {
	const draft = readChatMentionDraft(
		writeChatMentionDraft([file, sessionReference], "body"),
		sessions,
	);
	const next = writeChatMentionDraft(draft.references.slice(0, -1), draft.text);
	assert.deepEqual(readChatMentionDraft(next, sessions), {
		references: [file],
		text: "body",
	});
	assert.equal(writeChatMentionDraft([], "body"), "body");
});

test("repeated file picks do not produce duplicate chips or reference lines", () => {
	assert.equal(
		writeChatMentionDraft([file, file], "body"),
		'body\n@"src/chat composer.tsx"',
	);
	assert.deepEqual(
		readChatMentionDraft(
			`body\n${fileMentionValue(file.path)}\n${sessionMentionValue(session.path)}\n${fileMentionValue(file.path)}`,
			sessions,
		),
		{ references: [file, sessionReference], text: "body" },
	);
});

test("typing @ queries and unknown session paths remain literal", () => {
	for (const text of [
		"@",
		"@src/index.ts",
		"@/sessions/deleted.jsonl",
		'@"/sessions/deleted session.jsonl"',
		'@"~/sessions/deleted.jsonl"',
		String.raw`@"C:\Users\Dev User\sessions\deleted.jsonl"`,
		'@"unfinished',
		'@""',
	]) {
		assert.deepEqual(readChatMentionDraft(text, sessions), {
			references: [],
			text,
		});
	}
});

test("session-only drafts remain compatible and slash commands keep their prefix", () => {
	const text = writeChatMentionDraft([sessionReference], "/skill:review");
	assert.equal(text, `/skill:review\n${sessionMentionValue(session.path)}`);
	assert.deepEqual(readChatMentionDraft(text, sessions), {
		references: [sessionReference],
		text: "/skill:review",
	});
	assert.equal(
		createChatSubmission(writeChatMentionDraft([file], "/skill:review")).text,
		'/skill:review \n@"src/chat composer.tsx"',
	);
});

test("inline parts retain mixed reference order, duplicates and UTF-16 offsets", () => {
	const fileValue = fileMentionValue(file.path);
	const sessionValue = sessionMentionValue(session.path);
	const text = `前文😀 ${fileValue} middle ${sessionValue}\n${fileValue} 后文`;
	const parts = readChatMentionParts(text, sessions);
	assert.equal(parts.map((part) => part.value).join(""), text);
	assert.deepEqual(
		parts.filter((part) => part.mention).map((part) => part.mention),
		[file, sessionReference, file],
	);
	for (const part of parts)
		assert.equal(
			text.slice(part.start, part.start + part.value.length),
			part.value,
		);
	assert.equal(parts[1].start, "前文😀 ".length);
});

test("quoted file chips remain inline when adjacent spaces are deleted", () => {
	const value = fileMentionValue(file.path);
	const parts = readChatMentionParts(`前文${value}${value}后文`, sessions);
	assert.deepEqual(
		parts.map((part) => part.mention?.kind ?? "text"),
		["text", "file", "file", "text"],
	);
	assert.equal(
		parts.map((part) => part.value).join(""),
		`前文${value}${value}后文`,
	);
});

test("inline parser keeps incomplete queries and unknown sessions as text", () => {
	for (const text of [
		"@",
		"prefix @src/index.ts",
		'@"unfinished',
		'@""',
		"@/sessions/deleted.jsonl",
		'@"/sessions/deleted session.jsonl"',
		'@"~/unknown"',
	]) {
		assert.deepEqual(readChatMentionParts(text, sessions), [
			{ value: text, start: 0 },
		]);
	}
	assert.deepEqual(readChatMentionParts("", sessions), []);
});

test("inline parser prioritizes known sessions over file-shaped paths", () => {
	const relativeSession = { ...session, path: "previous session.jsonl" };
	const catalog = new Map([
		[sessionMentionValue(relativeSession.path), relativeSession],
	]);
	const [part] = readChatMentionParts(
		sessionMentionValue(relativeSession.path),
		catalog,
	);
	assert.equal(part.mention?.kind, "session");
	assert.equal(
		readChatMentionParts(
			`before ${sessionMentionValue(session.path)} after`,
			sessions,
		)[1].mention?.kind,
		"session",
	);
});

test("inline uploads preserve Unix, Windows and UNC attachment paths", () => {
	for (const path of [
		"/project/attachments/AAAAAAAAAAAAAAAAAAAAAA/report.txt",
		String.raw`C:\project\attachments\AAAAAAAAAAAAAAAAAAAAAA\report.txt`,
		String.raw`\\server\project\attachments\AAAAAAAAAAAAAAAAAAAAAA\report.txt`,
	]) {
		const value = fileMentionValue(path);
		const parts = readChatMentionParts(`before ${value} after`, sessions);
		assert.deepEqual(parts[1].mention, { kind: "file", path });
	}
});

test("inline references survive slash-command submission without being moved", () => {
	const text = `/skill:review check ${fileMentionValue(file.path)} before replying`;
	assert.equal(createChatSubmission(text).text, text);
});

test("reference shelf extracts completed inline drafts without moving body text to the front", () => {
	const value = `前文 ${fileMentionValue(file.path)} 后文\n${sessionMentionValue(session.path)}\n尾行`;
	assert.deepEqual(readChatMentionDraft(value, sessions), {
		references: [file, sessionReference],
		text: "前文  后文\n尾行",
	});
});

test("reference shelf deduplicates mixed inline and trailing references", () => {
	const value = `before ${fileMentionValue(file.path)} after\n${fileMentionValue(file.path)}\n${sessionMentionValue(session.path)}`;
	const draft = readChatMentionDraft(value, sessions);
	assert.deepEqual(draft, {
		references: [file, sessionReference],
		text: "before  after",
	});
	assert.deepEqual(
		readChatMentionDraft(
			writeChatMentionDraft(draft.references, draft.text),
			sessions,
		),
		draft,
	);
});
