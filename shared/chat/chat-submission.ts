import type { ChatConversationImage } from "./conversation-types";

export type { ChatConversationImage } from "./conversation-types";

export const MAX_CHAT_IMAGE_COUNT = 8;
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;

const CHAT_IMAGE_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
]);

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
	gif: "image/gif",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
};

export type ChatImageAttachment = {
	id: string;
	name: string;
	mimeType: string;
	size: number;
	data: string;
};

export type ChatSubmission = {
	text: string;
	images: ChatImageAttachment[];
	/** The sent body when image references were added without changing the draft. */
	message?: string;
};

export type PiImageContent = {
	type: "image";
	data: string;
	mimeType: string;
};

function normalizeChatSubmissionText(text: string): string {
	const trimmed = text.trim();
	// Pi splits Skill and extension command names on a literal space, not a newline.
	return trimmed.replace(/^\/\S+/, (command) =>
		trimmed.length > command.length && trimmed[command.length] !== " "
			? `${command} `
			: command,
	);
}

export function createChatSubmission(
	text: string,
	images: readonly ChatImageAttachment[] = [],
	message?: string,
): ChatSubmission {
	return {
		text: normalizeChatSubmissionText(text),
		images: [...images],
		...(message === undefined
			? {}
			: { message: normalizeChatSubmissionText(message) }),
	};
}

export function chatSubmissionMessage(submission: ChatSubmission): string {
	return submission.message ?? submission.text;
}

export function chatImageReferences(
	images: readonly Pick<ChatImageAttachment, "id" | "name">[],
	format: (reference: { index: number; name: string }) => string,
): Map<string, string> {
	return new Map(
		images.map(({ id, name }, index) => [
			id,
			format({ index: index + 1, name: name.replace(/[\r\n]+/g, " ") }),
		]),
	);
}

export function chatSubmissionHasContent(submission: ChatSubmission) {
	return Boolean(submission.text.trim()) || submission.images.length > 0;
}

export function summarizeChatImages(
	images: readonly ChatImageAttachment[],
): ChatConversationImage[] {
	return images.map(({ data: _data, ...image }) => ({
		...image,
		source: "local",
	}));
}

export function toPiImageContents(
	images: readonly ChatImageAttachment[],
): PiImageContent[] {
	return images.map((image) => ({
		type: "image",
		data: image.data,
		mimeType: image.mimeType,
	}));
}

export function resolveChatImageMimeType(file: Pick<File, "name" | "type">) {
	const explicit = file.type.toLowerCase();
	if (CHAT_IMAGE_MIME_TYPES.has(explicit)) return explicit;
	const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
	return IMAGE_MIME_BY_EXTENSION[extension] ?? null;
}

export function formatChatImageSize(size: number) {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
