import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown, defaultUrlTransform } from "streamdown";

import {
	projectMarkdownImageScope,
	resolveMarkdownImageSource,
} from "../../shared/chat/chat-markdown-images.ts";
import {
	loadChatHistoryImageUrl,
	loadChatProjectImageUrl,
} from "../../web/lib/chat/chat-image-media.ts";
import { MAX_CHAT_IMAGE_BYTES } from "../../shared/chat/chat-submission.ts";
import {
	MARKDOWN_COMPONENTS,
	MARKDOWN_REHYPE_PLUGINS,
} from "../../web/components/chat/chat-markdown-components.tsx";
import {
	ChatMarkdownImageScopeProvider,
	MarkdownImage,
} from "../../web/components/chat/chat-markdown-image.tsx";
import { initializeI18n } from "../../web/i18n/index.ts";

await initializeI18n("en-US");

test("external image loading reserves supplied dimensions and supports empty alt text", () => {
	const markup = renderToStaticMarkup(
		createElement(MarkdownImage, {
			src: "https://example.com/loading.png",
			alt: "",
			width: 240,
			height: 140,
		}),
	);
	assert.match(markup, /width="240"/);
	assert.match(markup, /height="140"/);
	assert.match(markup, /aspect-ratio:240 \/ 140/);
	assert.match(markup, /disabled=""/);
	assert.match(markup, /alt=""/);
	assert.match(markup, /invisible/);
});

test("Markdown image paths are decoded and normalized relative to the project", () => {
	assert.deepEqual(resolveMarkdownImageSource("./screenshots/page.png"), {
		type: "project",
		path: "screenshots/page.png",
		mimeType: "image/png",
	});
	assert.deepEqual(
		resolveMarkdownImageSource(".\\screenshots\\页面%20截图.JPG"),
		{
			type: "project",
			path: "screenshots/页面 截图.JPG",
			mimeType: "image/jpeg",
		},
	);
	for (const path of ["image.webp", "image.gif", "image.jpeg"])
		assert.equal(resolveMarkdownImageSource(path).type, "project");
});

test("Markdown images never resolve system paths, traversal, or unsupported schemes", () => {
	for (const path of [
		undefined,
		"",
		"/tmp/a.png",
		"//example.com/a.png",
		"../a.png",
		"x/../a.png",
		"%2e%2e/a.png",
		"%2ftmp/a.png",
		"C:\\a.png",
		"file:///tmp/a.png",
		"data:image/png;base64,AA==",
		"blob:example",
		"javascript:alert(1)",
		"a%00.png",
		"a.png?secret=x",
		"a.png#x",
		"a%3a.png",
		"a%0a.png",
		"a%.png",
		"a.svg",
		"a.txt",
		"a.constructor",
		"a.__proto__",
		`${"x".repeat(4097)}.png`,
	])
		assert.deepEqual(
			resolveMarkdownImageSource(path),
			{ type: "invalid" },
			String(path),
		);
});

test("Markdown preview image scopes resolve from the document directory within the project", () => {
	const project = { id: "preview-images", path: "/work/project" };
	for (const [filePath, directory, imagePath] of [
		["/work/project/README.md", "", "diagram.png"],
		["/work/project/docs/README.md", "docs", "docs/diagram.png"],
	]) {
		const scope = projectMarkdownImageScope(project, filePath);
		assert.ok(scope);
		assert.equal(scope.projectId, project.id);
		assert.equal(scope.baseDirectory, directory);
		assert.deepEqual(
			resolveMarkdownImageSource("./diagram.png", scope.baseDirectory),
			{
				type: "project",
				path: imagePath,
				mimeType: "image/png",
			},
		);
	}
	assert.deepEqual(resolveMarkdownImageSource("../diagram.png", "docs"), {
		type: "project",
		path: "diagram.png",
		mimeType: "image/png",
	});
	for (const src of [
		"../../secret.png",
		"/tmp/secret.png",
		"file:///tmp/a.png",
		"%2e%2e/%2e%2e/a.png",
	])
		assert.equal(resolveMarkdownImageSource(src, "docs").type, "invalid");
	for (const filePath of [
		"/work/project-other/README.md",
		"/tmp/README.md",
		"/work/project/docs/../../README.md",
	])
		assert.equal(projectMarkdownImageScope(project, filePath), null);
	assert.equal(
		projectMarkdownImageScope(
			{ id: "win", path: "C:\\Project" },
			"\\\\?\\C:\\Project\\docs\\README.md",
		)?.baseDirectory,
		"docs",
	);
	assert.equal(
		projectMarkdownImageScope({ id: "root", path: "/" }, "/docs/README.md")
			?.baseDirectory,
		"docs",
	);
});

test("ordinary HTTP(S) image URLs stay external", () => {
	for (const url of [
		"https://example.com/a.png?size=2",
		"http://localhost:3000/a.png",
	])
		assert.deepEqual(resolveMarkdownImageSource(url), {
			type: "external",
			url,
		});
	assert.equal(
		resolveMarkdownImageSource("https://user:secret@example.com/a.png").type,
		"invalid",
	);
});

function renderMarkdown(text: string, baseDirectory?: string) {
	return renderToStaticMarkup(
		createElement(
			ChatMarkdownImageScopeProvider,
			{
				scope: {
					projectId: "project",
					sessionKey: "session",
					baseDirectory,
					readImage: async () => new Uint8Array(),
				},
			},
			createElement(
				Streamdown,
				{
					mode: "static",
					components: MARKDOWN_COMPONENTS,
					urlTransform: defaultUrlTransform,
					rehypePlugins: MARKDOWN_REHYPE_PLUGINS,
				},
				text,
			),
		),
	);
}

test("Markdown pipeline routes project images through the loader, not browser-relative URLs", () => {
	const html = renderMarkdown(
		"Before\n\n![Page](./screenshots/page.png)\n\nAfter",
	);
	assert.match(html, /Before/);
	assert.match(html, /After/);
	assert.match(html, /title="screenshots\/page.png"/);
	assert.match(html, /aria-label="View image Page"/);
	assert.doesNotMatch(html, /src="(?:\.\/)?screenshots\/page.png"/);
});

test("Markdown preview pipeline preserves relative images until document scope resolution", () => {
	const html = renderMarkdown(
		"![Diagram](./diagram.png) ![Parent](../overview.png) ![Escape](../../secret.png)",
		"docs",
	);
	assert.match(html, /title="docs\/diagram.png"/);
	assert.match(html, /title="overview.png"/);
	assert.match(html, /Image unavailable/);
	assert.doesNotMatch(html, /title="[^"]*secret|src="(?:\.\/|\.\.\/|docs\/)/);
});

test("Markdown pipeline rejects unsafe image sources and preserves HTTPS images", () => {
	for (const url of [
		"../secret.png",
		"file:///tmp/a.png",
		"data:image/png;base64,AA==",
	])
		assert.match(renderMarkdown(`![Unsafe](${url})`), /Image unavailable/);
	const external = renderMarkdown("![Photo](https://example.com/photo.png)");
	assert.match(external, /src="https:\/\/example.com\/photo.png"/);
	assert.match(external, /alt="Photo"/);
});

test("project image loads deduplicate only in flight and reread overwritten files", async () => {
	let reads = 0;
	let content = "image-1";
	const scope = {
		projectId: "image-cache-test",
		sessionKey: "session-1",
		readImage: async (projectId: string, path: string) => {
			assert.equal(projectId, "image-cache-test");
			assert.equal(path, "page.png");
			reads++;
			return new TextEncoder().encode(content);
		},
	};
	const [first, second] = await Promise.all([
		loadChatProjectImageUrl("page.png", "image/png", scope),
		loadChatProjectImageUrl("page.png", "image/png", scope),
	]);
	assert.equal(first, second);
	assert.equal(reads, 1);
	assert.equal(await (await fetch(first)).text(), "image-1");
	content = "image-2";
	const refreshed = await loadChatProjectImageUrl(
		"page.png",
		"image/png",
		scope,
	);
	assert.notEqual(refreshed, first);
	assert.equal(reads, 2);
	assert.equal(await (await fetch(refreshed)).text(), "image-2");
	// A new read must not revoke URLs still displayed by earlier replies.
	assert.equal(await (await fetch(first)).text(), "image-1");
	await loadChatProjectImageUrl("page.png", "image/png", {
		...scope,
		sessionKey: "session-2",
	});
	assert.equal(reads, 3);
});

test("failed project image reads can retry and oversized payloads are rejected", async () => {
	let reads = 0;
	const scope = {
		projectId: "failed-image-test",
		sessionKey: "session",
		readImage: async () => {
			if (++reads === 1) throw new Error("not found");
			return new Uint8Array([1]);
		},
	};
	await assert.rejects(
		loadChatProjectImageUrl("a.png", "image/png", scope),
		/not found/,
	);
	assert.match(
		await loadChatProjectImageUrl("a.png", "image/png", scope),
		/^blob:/,
	);
	await assert.rejects(
		loadChatProjectImageUrl("large.png", "image/png", {
			...scope,
			readImage: async () => new Uint8Array(MAX_CHAT_IMAGE_BYTES + 1),
		}),
		/too large/,
	);
});

test("project image URL retention stays bounded across fresh reads", async () => {
	const scope = {
		projectId: "bounded-project-image-test",
		sessionKey: "session",
		readImage: async () => new Uint8Array([1]),
	};
	const urls: string[] = [];
	for (let index = 0; index < 49; index++) {
		// oxlint-disable-next-line no-await-in-loop -- Sequential reads test eviction, not in-flight deduplication.
		urls.push(await loadChatProjectImageUrl("page.png", "image/png", scope));
	}
	assert.equal(new Set(urls).size, 49);
	await assert.rejects(fetch(urls[0]));
	assert.equal((await fetch(urls[48])).status, 200);
});

test("history image reads keep their session fingerprint and MIME after cache reuse", async () => {
	const fingerprint = { fileSize: 42, fileMtimeNs: "99" };
	let reads = 0;
	const url = await loadChatHistoryImageUrl(
		"history-image-regression",
		{ id: "entry:0", mimeType: "image/gif" },
		{
			projectId: "project",
			sessionPath: "session.jsonl",
			fingerprint,
			readImage: async (...args) => {
				reads++;
				assert.deepEqual(args, [
					"project",
					"session.jsonl",
					"entry:0",
					fingerprint,
				]);
				return new TextEncoder().encode("GIF89a");
			},
		},
	);
	assert.equal(
		await loadChatHistoryImageUrl(
			"history-image-regression",
			{ id: "entry:0", mimeType: "image/gif" },
			{
				projectId: "project",
				sessionPath: "session.jsonl",
				fingerprint,
				readImage: async () => {
					throw new Error("Cached history image should not be read again");
				},
			},
		),
		url,
	);
	assert.equal(reads, 1);
	const response = await fetch(url);
	assert.equal(response.headers.get("content-type"), "image/gif");
	assert.equal(await response.text(), "GIF89a");
});
