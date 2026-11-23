import assert from "node:assert/strict";
import test from "node:test";

import {
	projectMarkdownImageScope,
	resolveMarkdownImageSource,
} from "../../shared/chat/chat-markdown-images.ts";

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
