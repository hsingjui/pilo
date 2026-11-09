import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown, defaultUrlTransform } from "streamdown";

import {
	resolveMarkdownFileLink,
	resolveMarkdownFileUrl,
} from "../../src/lib/chat/chat-markdown-links.ts";
import {
	MARKDOWN_COMPONENTS,
	MARKDOWN_REHYPE_PLUGINS,
} from "../../src/components/chat/chat-markdown-components.tsx";
import { openFileLink } from "../../src/lib/api/file-links.ts";
import { initializeI18n } from "../../src/i18n/index.ts";
import {
	markdownSearchText,
	searchTextMatches,
} from "../../src/lib/chat/chat-search-text.ts";

await initializeI18n("en-US");

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

function renderMarkdown(text: string, mode: "static" | "streaming" = "static") {
	return renderToStaticMarkup(
		createElement(
			Streamdown,
			{
				mode,
				components: MARKDOWN_COMPONENTS,
				urlTransform: defaultUrlTransform,
				rehypePlugins: MARKDOWN_REHYPE_PLUGINS,
			},
			text,
		),
	);
}

test("file reports survive sanitize and harden without a navigable file href", () => {
	for (const mode of ["static", "streaming"] as const) {
		for (const text of [
			"[查看报告](file:///Users/example/report.html)",
			'<a href="file:///Users/example/report.html">查看报告</a>',
		]) {
			const html = renderMarkdown(text, mode);
			assert.match(html, /<button[^>]+type="button"/);
			assert.match(html, /title="file:\/\/\/Users\/example\/report.html"/);
			assert.match(html, /<span[^>]*>查看报告<\/span>/);
			assert.doesNotMatch(html, /href="(?:file:|https:\/\/pilo.invalid)/);
			assert.doesNotMatch(html, /\[blocked\]/);
		}
	}
});

test("raw file URL labels become decoded filenames in static and streaming Markdown", () => {
	for (const mode of ["static", "streaming"] as const) {
		for (const url of [
			"file:///Users/example/My%20Pages/%E6%8A%A5%E5%91%8A%20page.html",
			"file:///C:/Users/example/report.HTM",
		]) {
			const html = renderMarkdown(`[${url}](${url})`, mode);
			const filename = decodeURIComponent(
				new URL(url).pathname.split("/").at(-1) ?? "",
			);
			assert.ok(html.includes(`>${filename}</span>`));
			assert.doesNotMatch(html, />file:\/\//);
			assert.match(html, /title="file:\/\//);
			assert.match(html, /aria-hidden="true"/);
		}
	}
});

test("custom and formatted report labels stay intact, including invalid targets", () => {
	assert.match(
		renderMarkdown("[**Read report**](file:///tmp/report.html)"),
		/data-streamdown="strong">Read report<\/span>/,
	);
	assert.match(
		renderMarkdown("[Read report](file:///tmp/report.exe)"),
		/<span[^>]*>Read report<\/span>/,
	);
});

test("file chips and search share labels and preserve both Report occurrences", () => {
	for (const markdown of [
		"[Report](file:///tmp/report.html) Report",
		'<a href="file:///tmp/report.html">Report</a> Report',
	]) {
		assert.equal(
			searchTextMatches(markdownSearchText(markdown), "Report").length,
			2,
		);
		assert.match(
			renderMarkdown(markdown),
			/<button[^>]*data-chat-search-reference=""/,
		);
	}
	const url = "file:///tmp/private-folder/My%20Report.html";
	assert.equal(markdownSearchText(`[${url}](${url})`), "My Report.html");
	assert.equal(
		searchTextMatches(markdownSearchText(`[${url}](${url})`), "private-folder")
			.length,
		0,
	);
	assert.equal(markdownSearchText(`[**${url}**](${url})`), url);
	assert.equal(markdownSearchText(`[Custom label](${url})`), "Custom label");
	assert.equal(
		markdownSearchText(
			`[file://server/report.html](file://server/report.html)`,
		),
		"file://server/report.html",
	);
});

test("ordinary links and sanitization stay intact, including spoofed metadata", () => {
	const ordinary = renderMarkdown(
		"[Site](https://example.com) [Mail](mailto:a@example.com)",
	);
	assert.match(ordinary, /href="https:\/\/example.com\/"/);
	assert.match(ordinary, /href="mailto:a@example.com"/);
	assert.match(ordinary, /rel="[^"]*noopener noreferrer[^"]*"/);
	assert.match(ordinary, /target="_blank"/);
	const unsafe = renderMarkdown(
		'<a href="javascript:alert(1)" data-pilo-file-url="file:///tmp/a.html" onclick="alert(1)">Unsafe</a><script>alert(1)</script><img src="file:///tmp/a.html">',
	);
	assert.doesNotMatch(
		unsafe,
		/<button|onclick=|<script|javascript:|src="file:/,
	);
});

test("WebUI refuses file opening before any desktop IPC", async () => {
	await assert.rejects(
		openFileLink(null, "file:///tmp/report.html"),
		/File links are not supported in WebUI yet/,
	);
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

test("relative line references survive sanitization in both Markdown modes", () => {
	for (const mode of ["static", "streaming"] as const)
		for (const target of [
			"README.md:12:3",
			"Dockerfile:8",
			"a.b.c.ts:3-5",
			"src/main.ts#L12-L18",
		])
			for (const markdown of [
				`[Source](${target})`,
				`<a href="${target}">Source</a>`,
			]) {
				const html = renderMarkdown(markdown, mode);
				assert.match(html, /<button[^>]+type="button"/);
				assert.match(html, />Source<\/span>/);
				assert.doesNotMatch(html, /\[blocked\]|href=/);
				assert.equal(markdownSearchText(markdown), "Source");
			}
});

test("absolute source labels retain compact ranges and WebUI still rejects opening", async () => {
	const target = "file:///repo/src/main.ts#L12-L18";
	assert.equal(markdownSearchText(`[${target}](${target})`), "main.ts:12-18");
	assert.match(
		renderMarkdown(`[${target}](${target})`),
		/>main.ts:12-18<\/span>/,
	);
	const resolved = resolveMarkdownFileLink("src/main.ts:12", "/repo");
	assert.ok(resolved);
	await assert.rejects(
		openFileLink(null, resolved.url),
		/not supported in WebUI/,
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
			import { rehypeRelativeFileLinks, resolveMarkdownFileLink } from "./src/lib/chat/chat-markdown-links.ts";
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
