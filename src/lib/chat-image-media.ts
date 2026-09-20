import {
	readSessionHistoryImage,
	type SessionHistoryFingerprint,
} from "@/lib/sessions";
import type {
	ChatConversationImage,
	ChatImageAttachment,
} from "@/lib/chat-submission";

/**
 * Images render from Blob object URLs instead of multi-megabyte data: URLs.
 * URLs are cached per image key and evicted LRU so long conversations do not
 * accumulate unbounded blob storage.
 */

const MAX_CACHED_IMAGE_URLS = 48;

type CachedImageUrl = {
	url: string;
};

const imageUrlCache = new Map<string, CachedImageUrl>();
const historyImageFetches = new Map<string, Promise<string>>();

function touchImageUrl(key: string) {
	const entry = imageUrlCache.get(key);
	if (!entry) return;
	imageUrlCache.delete(key);
	imageUrlCache.set(key, entry);
}

function storeImageUrl(key: string, blob: Blob): string {
	const url = URL.createObjectURL(blob);
	imageUrlCache.set(key, { url });
	while (imageUrlCache.size > MAX_CACHED_IMAGE_URLS) {
		const oldest = imageUrlCache.keys().next().value;
		if (oldest === undefined) break;
		const entry = imageUrlCache.get(oldest);
		imageUrlCache.delete(oldest);
		if (entry) URL.revokeObjectURL(entry.url);
	}
	return url;
}

function base64ToBlob(data: string, mimeType: string): Blob {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return new Blob([bytes], { type: mimeType });
}

export type ChatHistoryImageScope = {
	projectId: string;
	sessionPath: string;
	fingerprint?: SessionHistoryFingerprint | null;
};

function localChatImageCacheKey(imageId: string): string {
	return `local\0${imageId}`;
}

/** Stable cache key scoped to project + session snapshot for history images. */
export function chatImageCacheKey(
	image: Pick<ChatConversationImage, "id">,
	scope: ChatHistoryImageScope | null,
): string {
	if (!scope) return image.id;
	const fingerprint = scope.fingerprint
		? `${scope.fingerprint.fileSize}:${scope.fingerprint.fileMtimeNs}`
		: "?";
	return `${scope.projectId}\0${scope.sessionPath}\0${fingerprint}\0${image.id}`;
}

export function cacheLocalChatImage(image: ChatImageAttachment): string {
	const key = localChatImageCacheKey(image.id);
	const entry = imageUrlCache.get(key);
	if (entry) {
		touchImageUrl(key);
		return entry.url;
	}
	return storeImageUrl(key, base64ToBlob(image.data, image.mimeType));
}

export function cacheLocalChatImages(images: readonly ChatImageAttachment[]) {
	for (const image of images) cacheLocalChatImage(image);
}

export function getLocalChatImageUrl(imageId: string): string | null {
	const key = localChatImageCacheKey(imageId);
	const entry = imageUrlCache.get(key);
	if (!entry) return null;
	touchImageUrl(key);
	return entry.url;
}

/**
 * Lazily loads a history image payload. Concurrent requests for the same key
 * share one IPC round trip; resolved URLs land in the shared LRU cache.
 */
export function loadChatHistoryImageUrl(
	key: string,
	image: ChatConversationImage,
	scope: ChatHistoryImageScope,
): Promise<string> {
	const entry = imageUrlCache.get(key);
	if (entry) {
		touchImageUrl(key);
		return Promise.resolve(entry.url);
	}
	const inFlight = historyImageFetches.get(key);
	if (inFlight) return inFlight;
	const request = readSessionHistoryImage(
		scope.projectId,
		scope.sessionPath,
		image.id,
		scope.fingerprint ?? undefined,
	)
		.then((bytes) =>
			storeImageUrl(key, new Blob([bytes], { type: image.mimeType })),
		)
		.finally(() => {
			if (historyImageFetches.get(key) === request) {
				historyImageFetches.delete(key);
			}
		});
	historyImageFetches.set(key, request);
	return request;
}
