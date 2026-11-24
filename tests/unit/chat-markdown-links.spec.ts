import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
	annotateMarkdownDocumentFileLinks,
	extractTrailingLineRange,
	fileLinkPreviewKind,
	formatChatFileLinkHref,
	resolveChatFileLink,
	resolveInlineCodeFileLink,
	resolveMarkdownFileLink,
	resolveMarkdownFileUrl,
	splitPlainTextFileLinks,
} from "../../shared/chat/chat-markdown-links.ts";

test("file links support HTML reports, Unicode, spaces and Windows drive paths", () => {
	for (const url of [
		"file:///Users/example/.answer-me-with-html/pages/report.html",
		"file:///tmp/报告 page.html",
		"file:///C:/Users/example/My%20Pages/report.HTM",
		"file://localhost/tmp/report.html",
		"FILE:///tmp/report.html",
	]) {
		assert.equal(resolveMarkdownFileUrl(url), new URL(url).href);
	}
});

test("file links reject network paths and malformed URLs", () => {
	for (const url of [
		"https://example.com/report.html",
		"javascript:alert(1)",
		"data:text/html,hello",
		"/tmp/report.html",
		"file:report.html",
		"file://server/share/report.html",
		"file:////server/share/report.html",
		"file://user:password@localhost/report.html",
		"file:///tmp/report.html/",
		"file:///tmp/report.html?x=1",
		"file:///tmp/report.html#section",
		"file:///tmp/report.html?",
		"file:///tmp/report.html#",
		"file:///tmp/report%00.html",
		"file:///tmp/report%0a.html",
		"file:///tmp/report\n.html",
		"file:///tmp/report%.html",
		"file:///tmp/%2fserver/report.html",
		"file:///tmp/%5cserver/report.html",
		"file:///C:/report.exe:payload.html",
		"file:///tmp/report\\page.html",
		`file:///tmp/${"x".repeat(4096)}.html`,
	]) {
		assert.equal(resolveMarkdownFileUrl(url), null, url);
	}
});

test("relative file links resolve from POSIX and Windows project roots", () => {
	for (const [root, expected] of [
		["/repo", "file:///repo/"],
		["C:\\My Repo", "file:///C:/My%20Repo/"],
		["\\\\?\\C:\\My Repo\\", "file:///C:/My%20Repo/"],
	]) {
		for (const [path, encoded] of [
			["resources/design.md", "resources/design.md"],
			["./src/../README.md#intro", "README.md"],
			[
				"docs/%E6%8A%A5%E5%91%8A%20page.md",
				"docs/%E6%8A%A5%E5%91%8A%20page.md",
			],
		])
			assert.deepEqual(resolveMarkdownFileLink(path, root), {
				url: expected + encoded,
			});
	}
	assert.equal(resolveMarkdownFileLink("README.md"), null);
});

test("file locations support single lines, ranges and ignored columns", () => {
	for (const location of [":12", ":12:3", "#L12", "#L12C3"])
		assert.deepEqual(resolveMarkdownFileLink(`README.md${location}`, "/repo"), {
			url: "file:///repo/README.md",
			lineRange: { start: 12, end: 12 },
		});
	for (const location of [":12-18", ":12:3-18:7", "#L12-L18", "#L12C3-L18C7"])
		for (const path of ["src/main.ts", "file:///repo/src/main.ts"])
			assert.deepEqual(resolveMarkdownFileLink(path + location, "/repo"), {
				url: "file:///repo/src/main.ts",
				lineRange: { start: 12, end: 18 },
			});
	for (const name of [
		"Dockerfile",
		"Makefile",
		"LICENSE",
		"README",
		".env",
		"a.b.c.ts",
	])
		assert.deepEqual(resolveMarkdownFileLink(`${name}:3`, "/repo"), {
			url: `file:///repo/${name}`,
			lineRange: { start: 3, end: 3 },
		});
});

test("file locations reject invalid ranges, traversal and unsafe URLs", () => {
	for (const value of [
		"../secret.ts",
		"src/../../secret.ts",
		"%2e%2e/secret.ts",
		"src%2fmain.ts",
		"src%5cmain.ts",
		"src\\main.ts",
		"bad%.ts",
		"src/main.ts?raw=1",
		"src/%00main.ts",
		"src/main\n.ts",
		"/tmp/main.ts",
		"https://example.com/main.ts",
		"javascript:alert(1)",
		"file://server/main.ts",
		"file:///repo/main.ts?raw=1#L12",
		"file:///repo/report.html#L12",
		"file:///repo/doc.pdf:12",
		"file:///repo/main.ts#intro",
		"file:///repo/main.ts#",
	])
		assert.equal(resolveMarkdownFileLink(value, "/repo"), null, value);
	for (const location of [
		":0",
		":18-12",
		":9007199254740992",
		"#L0",
		"#L18-L12",
		"#L1-L9007199254740992",
	])
		for (const path of ["README.md", "file:///repo/README.md"])
			assert.equal(
				resolveMarkdownFileLink(path + location, "/repo"),
				null,
				path + location,
			);
});

test("oversized dotted hrefs are rejected without blocking the Markdown plugin", () => {
	// Isolate synchronous regex work: a regression must time out, not hang the runner.
	const result = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"--import",
			"./tests/helpers/tsx-loader.mjs",
			"--input-type=module",
			"--eval",
			`
			import assert from "node:assert/strict";
			import { rehypeRelativeFileLinks, resolveMarkdownFileLink } from "./shared/chat/chat-markdown-links.ts";
			for (const href of [".".repeat(100_000), "a.b.".repeat(25_000) + "ts:12"]) {
				const node = { tagName: "a", properties: { href } };
				rehypeRelativeFileLinks()(node);
				assert.equal(node.properties.href, href);
				assert.equal(resolveMarkdownFileLink(href, "/repo"), null);
			}
		`,
		],
		{ encoding: "utf8", timeout: 10_000 },
	);
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
});

test("chat file links support :L line syntax, Windows paths, and expanded preview types", () => {
	assert.deepEqual(resolveChatFileLink("src/main.ts:L12", "/repo"), {
		url: "file:///repo/src/main.ts",
		lineRange: { start: 12, end: 12 },
	});
	assert.deepEqual(resolveChatFileLink("src/main.ts:L12-L18", "/repo"), {
		url: "file:///repo/src/main.ts",
		lineRange: { start: 12, end: 18 },
	});
	assert.deepEqual(
		resolveChatFileLink("app\\chat\\chat-markdown.tsx:42-50", "D:\\Code\\pilo"),
		{
			url: "file:///D:/Code/pilo/app/chat/chat-markdown.tsx",
			lineRange: { start: 42, end: 50 },
		},
	);
	assert.deepEqual(resolveChatFileLink("\\\\?\\D:\\Code\\pilo\\App.tsx:9"), {
		url: "file:///D:/Code/pilo/App.tsx",
		lineRange: { start: 9, end: 9 },
	});
	assert.equal(
		formatChatFileLinkHref({
			url: "file:///repo/src/main.ts",
			lineRange: { start: 12, end: 12 },
		}),
		"file:///repo/src/main.ts#L12",
	);
	assert.equal(
		formatChatFileLinkHref({
			url: "file:///repo/src/main.ts",
			lineRange: { start: 12, end: 18 },
		}),
		"file:///repo/src/main.ts#L12-L18",
	);
	assert.equal(fileLinkPreviewKind("proto/pilo.proto"), "code");
	assert.equal(fileLinkPreviewKind("styles/theme.scss"), "code");
	assert.equal(fileLinkPreviewKind(".editorconfig"), "code");
	assert.equal(fileLinkPreviewKind(".env.local"), "code");
	assert.equal(fileLinkPreviewKind("Dockerfile.dev"), "code");
	assert.equal(fileLinkPreviewKind("justfile"), "code");
	assert.equal(fileLinkPreviewKind("report.html"), null);
	assert.equal(fileLinkPreviewKind("data.csv"), null);
});

test("inline code file links detect file paths and reject code identifiers", () => {
	assert.deepEqual(
		resolveInlineCodeFileLink("app/chat/chat-markdown.tsx:274-290", "/repo"),
		{
			url: "file:///repo/app/chat/chat-markdown.tsx",
			lineRange: { start: 274, end: 290 },
		},
	);
	assert.deepEqual(resolveInlineCodeFileLink("App.tsx", "/repo"), {
		url: "file:///repo/App.tsx",
	});
	assert.deepEqual(resolveInlineCodeFileLink("Cargo.toml:15", "/repo"), {
		url: "file:///repo/Cargo.toml",
		lineRange: { start: 15, end: 15 },
	});
	assert.deepEqual(resolveInlineCodeFileLink("Dockerfile", "/repo"), {
		url: "file:///repo/Dockerfile",
	});
	assert.deepEqual(resolveInlineCodeFileLink(".env.local", "/repo"), {
		url: "file:///repo/.env.local",
	});
	assert.deepEqual(resolveInlineCodeFileLink("logs/app.log", "/repo"), {
		url: "file:///repo/logs/app.log",
	});
	assert.deepEqual(resolveInlineCodeFileLink("app.log:42", "/repo"), {
		url: "file:///repo/app.log",
		lineRange: { start: 42, end: 42 },
	});
	assert.deepEqual(
		resolveInlineCodeFileLink("D:\\Code\\pilo\\App.tsx:9", "/repo"),
		{
			url: "file:///D:/Code/pilo/App.tsx",
			lineRange: { start: 9, end: 9 },
		},
	);
	for (const nonFile of [
		"inline code",
		"console.log",
		"process.env",
		"props.text",
		"v1.2.3",
		"example.com",
		"image/png",
		"application/json",
		"Desktop/WebUI",
		"@shared/chat/chat-markdown-links.ts",
		"https://example.com/main.ts",
		"git diff src/main.ts",
		"../secret.ts",
		"~/notes.md",
	]) {
		assert.equal(resolveInlineCodeFileLink(nonFile, "/repo"), null, nonFile);
	}
});

test("trailing line ranges parse direct suffixes and prose annotations", () => {
	assert.deepEqual(extractTrailingLineRange(":42."), {
		lineRange: { start: 42, end: 42 },
		consumeLength: 3,
	});
	assert.deepEqual(extractTrailingLineRange(":42-50 and more"), {
		lineRange: { start: 42, end: 50 },
		consumeLength: 6,
	});
	assert.deepEqual(extractTrailingLineRange("#L10-L20,"), {
		lineRange: { start: 10, end: 20 },
		consumeLength: 8,
	});
	assert.deepEqual(extractTrailingLineRange(" (line 42) has the fix"), {
		lineRange: { start: 42, end: 42 },
		consumeLength: 0,
	});
	assert.deepEqual(extractTrailingLineRange(" (lines 12-18)"), {
		lineRange: { start: 12, end: 18 },
		consumeLength: 0,
	});
	assert.deepEqual(extractTrailingLineRange("（第 12-18 行）"), {
		lineRange: { start: 12, end: 18 },
		consumeLength: 0,
	});
	assert.deepEqual(extractTrailingLineRange(" 第 274 行"), {
		lineRange: { start: 274, end: 274 },
		consumeLength: 0,
	});
	assert.equal(extractTrailingLineRange(":0"), null);
	assert.equal(extractTrailingLineRange(":50-10"), null);
	assert.equal(extractTrailingLineRange(" is a file"), null);
});

test("plain text file links detect paths and line locations while skipping URLs and prose", () => {
	const segments = splitPlainTextFileLinks(
		"Check app/chat/chat-markdown.tsx:274-290, App.tsx:9, and https://example.com/src/main.ts:10 or Node.js.",
		"/repo",
	);
	assert.deepEqual(segments, [
		{ type: "text", text: "Check " },
		{
			type: "link",
			text: "app/chat/chat-markdown.tsx:274-290",
			link: {
				url: "file:///repo/app/chat/chat-markdown.tsx",
				lineRange: { start: 274, end: 290 },
			},
		},
		{ type: "text", text: ", " },
		{
			type: "link",
			text: "App.tsx:9",
			link: {
				url: "file:///repo/App.tsx",
				lineRange: { start: 9, end: 9 },
			},
		},
		{
			type: "text",
			text: ", and https://example.com/src/main.ts:10 or Node.js.",
		},
	]);

	const cjk = splitPlainTextFileLinks(
		"修改了src/main.ts:12（并参考file:///repo/README.md#L3）和app/chat/chat-markdown.tsx（第 274-290 行）以及docs/设计文档.md:5。",
		"/repo",
	);
	assert.deepEqual(
		cjk
			.filter((part) => part.type === "link")
			.map((part) => ({ text: part.text, link: part.link })),
		[
			{
				text: "src/main.ts:12",
				link: {
					url: "file:///repo/src/main.ts",
					lineRange: { start: 12, end: 12 },
				},
			},
			{
				text: "file:///repo/README.md#L3",
				link: {
					url: "file:///repo/README.md",
					lineRange: { start: 3, end: 3 },
				},
			},
			{
				text: "app/chat/chat-markdown.tsx",
				link: {
					url: "file:///repo/app/chat/chat-markdown.tsx",
					lineRange: { start: 274, end: 290 },
				},
			},
			{
				text: "docs/设计文档.md:5",
				link: {
					url: "file:///repo/docs/%E8%AE%BE%E8%AE%A1%E6%96%87%E6%A1%A3.md",
					lineRange: { start: 5, end: 5 },
				},
			},
		],
	);

	assert.deepEqual(
		splitPlainTextFileLinks("修改了app/a.ts和app/b.ts", "/repo")
			.filter((part) => part.type === "link")
			.map((part) => part.text),
		["app/a.ts", "app/b.ts"],
	);

	assert.deepEqual(
		splitPlainTextFileLinks(
			"Compare Desktop/WebUI at 12:30 with v0.6.1 and localhost:3000.",
			"/repo",
		),
		[
			{
				type: "text",
				text: "Compare Desktop/WebUI at 12:30 with v0.6.1 and localhost:3000.",
			},
		],
	);
});

test("document annotation wraps inline code and plain text file refs without touching code blocks or nesting links", () => {
	const doc = annotateMarkdownDocumentFileLinks(
		{
			blocks: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "Updated " },
						{ type: "code", code: "src/main.ts" },
						{ type: "text", text: " (lines 12-18) and " },
						{ type: "code", code: "App.tsx" },
						{ type: "text", text: ":9 plus " },
						{ type: "code", code: "console.log" },
						{ type: "text", text: " and " },
						{
							type: "link",
							url: "src/main.ts",
							content: [{ type: "code", code: "src/main.ts:25" }],
						},
					],
				},
				{
					type: "codeBlock",
					language: "ts",
					code: "import './src/main.ts'; // src/main.ts:42",
				},
			],
		},
		"/repo",
	);
	const para = doc.blocks[0] as { type: "paragraph"; content: unknown[] };
	assert.deepEqual(para.content, [
		{ type: "text", text: "Updated " },
		{
			type: "link",
			url: "file:///repo/src/main.ts#L12-L18",
			content: [{ type: "text", text: "src/main.ts" }],
		},
		{ type: "text", text: " (lines 12-18) and " },
		{
			type: "link",
			url: "file:///repo/App.tsx#L9",
			content: [{ type: "text", text: "App.tsx:9" }],
		},
		{ type: "text", text: " plus " },
		{ type: "code", code: "console.log" },
		{ type: "text", text: " and " },
		{
			type: "link",
			url: "file:///repo/src/main.ts#L25",
			content: [{ type: "text", text: "src/main.ts:25" }],
		},
	]);
	assert.deepEqual(doc.blocks[1], {
		type: "codeBlock",
		language: "ts",
		code: "import './src/main.ts'; // src/main.ts:42",
	});
});
