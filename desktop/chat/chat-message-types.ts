import type { JSX } from "nsh";

import type { ChatMessage } from "@/lib/chat/conversation-types";

export type UserChatMessage = Extract<ChatMessage, { role: "user" }>;
export type AssistantChatMessage = Extract<ChatMessage, { role: "assistant" }>;
export type CompactionChatMessage = Extract<
	ChatMessage,
	{ role: "compaction" }
>;

/**
 * What draws a message's content inside its row. The list draws plain text;
 * a later renderer (Markdown, tool activity) replaces it here.
 */
export type ChatMessageBody<T extends ChatMessage> = (
	message: () => T,
) => JSX.Element;
