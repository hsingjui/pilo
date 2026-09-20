export const CHAT_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
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

/**
 * Lightweight image descriptor kept in conversation state.
 *
 * Local images are backed by the bounded Blob URL cache; history images are
 * loaded lazily from the session JSONL. Base64 payloads stay in submissions
 * only for as long as they are needed to send/recover a request.
 */
export type ChatConversationImage = {
	id: string;
	name?: string;
	mimeType: string;
	size?: number;
	source?: "local";
};

export type ChatSubmission = {
	text: string;
	images: ChatImageAttachment[];
};

export type PiImageContent = {
	type: "image";
	data: string;
	mimeType: string;
};

export function createChatSubmission(
	text: string,
	images: readonly ChatImageAttachment[] = [],
): ChatSubmission {
	return { text: text.trim(), images: [...images] };
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
