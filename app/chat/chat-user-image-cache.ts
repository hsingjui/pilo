import { computed } from "nsh";

import { bytesToBase64 } from "@shared/base64";
import {
	MAX_CHAT_IMAGE_BYTES,
	resolveChatImageMimeType,
} from "@shared/chat/chat-submission";
import type { ChatImageAttachment } from "@shared/chat/chat-submission";
import type { ChatConversationImage } from "@shared/chat/conversation-types";

/** Chat identity for reading live or saved images through the Host. */
export type ChatHistoryImageSource = {
	projectId: string;
	sessionPath?: string | null;
	sessionKey?: string | null;
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
 * A user image as a data URL, from the pending prompt or the Host.
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
	const session =
		image.source === "live" ? history?.sessionKey : history?.sessionPath;
	if (!history || !session) return Promise.reject(new Error("no image source"));
	const mimeType = resolveChatImageMimeType({
		name: image.name ?? "",
		type: image.mimeType,
	});
	if (!mimeType) {
		return Promise.reject(new Error("unsupported image format"));
	}
	const { projectId, read } = history;
	return cachedHistory(`${projectId}\0${session}\0${image.id}`, async () => {
		const bytes = await read(projectId, session, image.id);
		if (bytes.length > MAX_CHAT_IMAGE_BYTES) {
			throw new Error("image exceeds chat size limit");
		}
		const url = `data:${mimeType};base64,${bytesToBase64(bytes)}`;
		return { url, bytes: url.length };
	});
}

/** Keep thumbnail reads independent of unrelated app and run-config updates. */
export function createChatUserImageReader(
	historySource: () => ChatHistoryImageSource | null,
) {
	const history = computed(historySource, {
		equals: (previous, next) =>
			previous?.projectId === next?.projectId &&
			previous?.sessionPath === next?.sessionPath &&
			previous?.sessionKey === next?.sessionKey &&
			previous?.read === next?.read,
	});
	return (image: ChatConversationImage) =>
		readChatUserImage(image, image.source === "local" ? null : history());
}

/** Clears cached image URLs; intended for tests. */
export function clearChatUserImageCacheForTests() {
	historyImageUrls.clear();
	historyCachedBytes = 0;
	localImageUrls.clear();
}
