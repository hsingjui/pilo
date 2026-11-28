import type { PiloClientEvent } from "@shared/api/pilo-client";
import type {
	SessionHistory,
	SessionHistoryFingerprint,
} from "@shared/api/sessions-types";
import { INITIAL_HISTORY_MESSAGE_COUNT } from "@shared/chat/chat-history-window-model";
import type { ChatHistoryWindowStore } from "@shared/chat/chat-history-window-store";
import type {
	ChatMessage,
	ConversationAction,
	ConversationState,
} from "@shared/chat/conversation-types";
import type {
	ChatTranscriptSnapshot,
	ChatTranscriptWindow,
} from "@shared/api/host-methods";
import type { SessionHistoryMetadata } from "./chat-run-config";

export function historyMetadata({
	model,
	thinkingLevel,
	name,
	headerMissing,
	stats,
}: SessionHistory): SessionHistoryMetadata {
	return { model, thinkingLevel, name, headerMissing, stats };
}

export const TRANSCRIPT_CACHE_CAPACITY = 16;
export const interruptTurn = {
	type: "assistant_turn_end",
	completion: "interrupted",
} as const;

export type CachedTranscript = {
	projectId: string;
	sessionPath: string;
	fingerprint: SessionHistoryFingerprint;
	conversation: ConversationState;
	older: ChatHistoryWindowStore;
	saved: SavedHistory | undefined;
	historyPrefix: readonly ChatMessage[];
	history: SessionHistoryMetadata;
};

export const noMessages: readonly ChatMessage[] = [];

/** The session file a read's placeholders stand for. */
export type SavedHistory = {
	projectId: string;
	sessionPath: string;
	/** The file as the read found it; a page of a changed file is not used. */
	fingerprint: SessionHistoryFingerprint;
	/** The messages before the read's window, none of them loaded. */
	placeholders: readonly ChatMessage[];
	/** The loaded messages `historyPrefix` was last built with. */
	shown: ReadonlyMap<number, ChatMessage>;
	/** The first messages of the pages being read. */
	pages: Set<number>;
};

/**
 * A prompt sent from this app as the chat's next turn, shown before Pi
 * echoes it: the actions that put it and its pending reply on screen.
 */
export type LocalTurn = {
	clientMessageId: string;
	actions: ConversationAction[];
};

/** The conversation without a local turn's prompt and pending reply. */
export function withoutLocalTurn(
	conversation: ConversationState,
	clientMessageId: string,
): ConversationState {
	const owned = conversation.active?.localClientMessageId === clientMessageId;
	const replyId = owned ? conversation.active?.assistantMessageId : undefined;
	return {
		...conversation,
		messages: conversation.messages.filter(
			(message) => message.id !== clientMessageId && message.id !== replyId,
		),
		pendingUsers: conversation.pendingUsers.filter(
			(pending) => pending.clientMessageId !== clientMessageId,
		),
		active: owned ? null : conversation.active,
	};
}

/** What a read asks for: the session's last messages and its message index. */
export const firstWindow: ChatTranscriptWindow = {
	messageLimit: INITIAL_HISTORY_MESSAGE_COUNT,
	includeMessageIndex: true,
};

/** Whether the session file was missing when history was read. */
export function isMissingHistoryFile(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return message.endsWith("(os error 2)") || message.includes("ENOENT");
}

/** Whether the event says no turn is running in the chat any more. */
export function settles(event: PiloClientEvent) {
	return (
		event.type === "assistant_message_end" ||
		event.type === "runtime_error" ||
		(event.type === "pi_reattached" && !event.active) ||
		piExited(event)
	);
}

/** Whether the event says the chat's Pi process is gone. */
export function piExited(event: PiloClientEvent) {
	return (
		event.type === "process_state" &&
		(event.state === "failed" || event.state === "stopped")
	);
}

/** Whether the event is one the Host counts as a turn having started. */
export function startsTurn(event: PiloClientEvent) {
	return (
		event.type === "user_message_start" ||
		event.type === "assistant_message_start" ||
		event.type === "auto_retry_start"
	);
}
