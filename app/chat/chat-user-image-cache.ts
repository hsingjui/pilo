import { bytesToBase64 } from "@shared/base64";
import {
	MAX_CHAT_IMAGE_BYTES,
	resolveChatImageMimeType,
} from "@shared/chat/chat-submission";
import type { ChatImageAttachment } from "@shared/chat/chat-submission";
import type { ChatConversationImage } from "@shared/chat/conversation-types";

/** Where a saved message's images are read from (`NshPiloClient.readHistoryImage`). */
export type ChatHistoryImageSource = {
	projectId: string;
	sessionPath: string;
	read: (
		projectId: string,
		sessionPath: string,
		imageId: string,
	) => Promise<Uint8Array>;
};

// Keep bounded LRU caches; split local pending images from reloadable history images
// so scrolling through saved sessions never evicts an unsaved prompt's image.
const MAX_CACHED_HISTORY_IMAGES = 24;
const MAX_CACHED_HISTORY_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_LOCAL_IMAGES = 32;

type CachedHistoryEntry = {
	request: Promise<string>;
	bytes: number;
};

const historyImageUrls = new Map<string, CachedHistoryEntry>();
let historyCachedBytes = 0;

const localImageUrls = new Map<string, Promise<string>>();

function evictHistoryOverflow() {
	while (
		historyImageUrls.size > MAX_CACHED_HISTORY_IMAGES ||
		(historyImageUrls.size > 1 && historyCachedBytes > MAX_CACHED_HISTORY_BYTES)
	) {
		const oldest = historyImageUrls.entries().next().value;
		if (!oldest) break;
		const [key, entry] = oldest;
		historyImageUrls.delete(key);
		historyCachedBytes = Math.max(0, historyCachedBytes - entry.bytes);
	}
}

function cachedHistory(
	key: string,
	load: () => Promise<{ url: string; bytes: number }>,
): Promise<string> {
	const hit = historyImageUrls.get(key);
	if (hit) {
		historyImageUrls.delete(key);
		historyImageUrls.set(key, hit);
		return hit.request;
	}
	const entry: CachedHistoryEntry = {
		request: Promise.resolve(""),
		bytes: 0,
	};
	const request = load().then(
		({ url, bytes }) => {
			if (historyImageUrls.get(key) === entry) {
				entry.bytes = bytes;
				historyCachedBytes += bytes;
				evictHistoryOverflow();
			}
			return url;
		},
		(error) => {
			if (historyImageUrls.get(key) === entry) {
				historyImageUrls.delete(key);
				historyCachedBytes = Math.max(0, historyCachedBytes - entry.bytes);
			}
			throw error;
		},
	);
	entry.request = request;
	historyImageUrls.set(key, entry);
	evictHistoryOverflow();
	return request;
}

function localKey(imageId: string) {
	return `local\0${imageId}`;
}

/**
 * Keeps the images of a prompt being sent, so its bubble can show them
 * before Pi has written them to the session file.
 */
export function rememberLocalChatImages(
	images: readonly ChatImageAttachment[],
) {
	for (const image of images) {
		const key = localKey(image.id);
		const url = `data:${image.mimeType};base64,${image.data}`;
		localImageUrls.delete(key);
		localImageUrls.set(key, Promise.resolve(url));
		while (localImageUrls.size > MAX_CACHED_LOCAL_IMAGES) {
			const oldest = localImageUrls.keys().next().value;
			if (oldest === undefined) break;
			localImageUrls.delete(oldest);
		}
	}
}

/**
 * A user message image as a data URL: a prompt just sent from the cache,
 * a saved one from its session file.
 */
export function readChatUserImage(
	image: ChatConversationImage,
	history: ChatHistoryImageSource | null,
): Promise<string> {
	if (image.source === "local") {
		const key = localKey(image.id);
		const hit = localImageUrls.get(key);
		if (!hit) return Promise.reject(new Error("image is no longer available"));
		// Refresh LRU order on read.
		localImageUrls.delete(key);
		localImageUrls.set(key, hit);
		return hit;
	}
	if (!history) return Promise.reject(new Error("no saved session"));
	const mimeType = resolveChatImageMimeType({
		name: image.name ?? "",
		type: image.mimeType,
	});
	if (!mimeType) {
		return Promise.reject(new Error("unsupported image format"));
	}
	const { projectId, sessionPath, read } = history;
	return cachedHistory(
		`${projectId}\0${sessionPath}\0${image.id}`,
		async () => {
			const bytes = await read(projectId, sessionPath, image.id);
			if (bytes.length > MAX_CHAT_IMAGE_BYTES) {
				throw new Error("image exceeds chat size limit");
			}
			const url = `data:${mimeType};base64,${bytesToBase64(bytes)}`;
			return { url, bytes: url.length };
		},
	);
}

/** Clears cached image URLs; intended for tests. */
export function clearChatUserImageCacheForTests() {
	historyImageUrls.clear();
	historyCachedBytes = 0;
	localImageUrls.clear();
}
