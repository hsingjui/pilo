import { context } from "nsh";

import type { ChatConversationImage } from "@shared/chat/conversation-types";
import type { SessionMention } from "@shared/chat/session-mentions";

/** An image to display in the full-screen preview lightbox. */
export interface ChatImagePreview {
	/** External URL or base64 data URL. */
	url: string;
	/** Display title and suggested save filename. */
	name: string;
	/** File size in bytes, when known. */
	size?: number;
}

/** Shared preview/open callbacks provided by the app shell to chat rows. */
export interface ChatMediaActionsValue {
	openImage?: (image: ChatImagePreview) => void;
	/** Reads an image of a user message as a data URL. */
	readUserImage?: (image: ChatConversationImage) => Promise<string>;
	/** Saved sessions by their `@` mention token, for mention badges. */
	sessionMentions?: () => ReadonlyMap<string, SessionMention>;
	openFile?: (path: string) => void;
	canOpenFile?: (path: string) => boolean;
}

export const ChatMediaActions = context<ChatMediaActionsValue>({});
