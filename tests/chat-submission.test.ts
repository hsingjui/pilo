import assert from "node:assert/strict";
import test from "node:test";

import {
	chatSubmissionHasContent,
	createChatSubmission,
	resolveChatImageMimeType,
	summarizeChatImages,
	toPiImageContents,
	type ChatImageAttachment,
} from "../src/lib/chat-submission.ts";

const image: ChatImageAttachment = {
	id: "image-1",
	name: "screen.png",
	mimeType: "image/png",
	size: 3,
	data: "YWJj",
};

test("image-only submissions are valid and preserve image data", () => {
	const submission = createChatSubmission("   ", [image]);
	assert.equal(submission.text, "");
	assert.equal(chatSubmissionHasContent(submission), true);
	assert.deepEqual(toPiImageContents(submission.images), [
		{ type: "image", data: "YWJj", mimeType: "image/png" },
	]);
});

test("conversation image summaries do not retain base64 payloads", () => {
	assert.deepEqual(summarizeChatImages([image]), [
		{
			id: "image-1",
			name: "screen.png",
			mimeType: "image/png",
			size: 3,
			source: "local",
		},
	]);
});

test("image MIME type falls back to the file extension for clipboard/file inputs", () => {
	assert.equal(
		resolveChatImageMimeType({ name: "photo.JPG", type: "" }),
		"image/jpeg",
	);
	assert.equal(
		resolveChatImageMimeType({ name: "notes.txt", type: "text/plain" }),
		null,
	);
});
