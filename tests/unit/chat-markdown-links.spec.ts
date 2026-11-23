import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
	resolveMarkdownFileLink,
	resolveMarkdownFileUrl,
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
