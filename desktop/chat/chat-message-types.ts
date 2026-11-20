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

/** What draws one text of a reply, between its work (Markdown by default). */
export type ChatTextBody = (text: () => string) => JSX.Element;

/** The Host preferences that shape how a reply shows its work. */
export interface ChatWorkPreferences {
	/** Finished work folds behind its summary. */
	collapseCompletedActivity: boolean;
	/** Summaries say how long the work took. */
	showWorkDuration: boolean;
}
