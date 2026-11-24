import { context } from "nsh";

import type { Project } from "@shared/api/projects-types";
import type { ChatFileLink } from "@shared/chat/chat-markdown-links";
import type { ChatImageAttachment } from "@shared/chat/chat-submission";
import type { ChatConversationImage } from "@shared/chat/conversation-types";
import type { SessionMention } from "@shared/chat/session-mentions";
import type { WorkspaceLineRange } from "@shared/project-workspace";

/** An image to display in the full-screen preview lightbox. */
export interface ChatImagePreview {
	/** External URL or base64 data URL. */
	url: string;
	/** Display title and suggested save filename. */
	name: string;
	/** File size in bytes, when known. */
	size?: number;
}

export function chatAttachmentImage(
	image: ChatImageAttachment,
): ChatImagePreview {
	return {
		url: `data:${image.mimeType};base64,${image.data}`,
		name: image.name,
		size: image.size,
	};
}

/** Shared preview/open callbacks provided by the app shell to chat rows. */
export interface ChatMediaActionsValue {
	openImage?: (image: ChatImagePreview) => void;
	/** Reads an image of a user message as a data URL. */
	readUserImage?: (image: ChatConversationImage) => Promise<string>;
	/** Saved sessions by their `@` mention token, for mention badges. */
	sessionMentions?: () => ReadonlyMap<string, SessionMention>;
	/** Active project context for resolving relative file links in nested Markdown (e.g. thinking blocks). */
	project?: () => Pick<Project, "id" | "path"> | null;
	/** Opens a resolved Markdown file link (used as default by `ChatMarkdown` when `onFileLink` is omitted). */
	onFileLink?: (link: ChatFileLink) => void;
	openFile?: (path: string, lineRange?: WorkspaceLineRange) => void;
	canOpenFile?: (path: string) => boolean;
}

export const ChatMediaActions = context<ChatMediaActionsValue>({});
