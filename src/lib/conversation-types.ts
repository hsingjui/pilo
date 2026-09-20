import type { AssistantActivity } from "@/components/chat/chat-activity";
import type { AssistantContentItem } from "@/lib/chat-activity-state";
import type { ChatConversationImage } from "@/lib/chat-submission";

export type ChatMessage =
	| {
			id: string;
			role: "user";
			text: string;
			images?: ChatConversationImage[];
			time: string;
			timestampMs?: number;
			queued?: "steer" | "follow_up";
			historyPlaceholder?: boolean;
			historyEstimatedChars?: number;
	  }
	| {
			id: string;
			role: "assistant";
			text: string;
			time: string;
			timestampMs?: number;
			content?: AssistantContentItem[];
			activity?: AssistantActivity[];
			streaming?: boolean;
			workDurationMs?: number;
			replyRunwayPx?: number;
			stopReason?: string;
			errorMessage?: string;
			completion?: "complete" | "interrupted" | "continued";
			historyPlaceholder?: boolean;
			historyEstimatedChars?: number;
	  }
	| {
			id: string;
			role: "compaction";
			text: string;
			time: string;
			timestampMs?: number;
			tokensBefore?: number;
			historyPlaceholder?: boolean;
			historyEstimatedChars?: number;
	  };

export type ConversationEventMeta = {
	timestampMs?: number;
	sourceEntryId?: string;
	sourceContentIndex?: number;
};

export type ConversationEvent = ConversationEventMeta &
	(
		| {
				type: "user_message_start";
				text: string;
				images?: ChatConversationImage[];
		  }
		| { type: "compaction_marker"; summary: string; tokensBefore?: number }
		| { type: "assistant_message_start" }
		| { type: "assistant_text_delta"; delta: string }
		| { type: "assistant_text_snapshot"; text: string }
		| { type: "assistant_thinking_start" }
		| { type: "assistant_thinking_delta"; delta: string }
		| { type: "assistant_thinking_end" }
		| {
				type: "tool_execution_start";
				toolCallId: string;
				toolName: string;
				args: unknown;
		  }
		| {
				type: "tool_execution_update";
				toolCallId: string;
				toolName: string;
				args: unknown;
				partialResult: unknown;
		  }
		| {
				type: "tool_execution_end";
				toolCallId: string;
				toolName: string;
				result: unknown;
				isError: boolean;
		  }
		| {
				type: "assistant_turn_end";
				stopReason?: string | null;
				errorMessage?: string | null;
				completion?: "complete" | "interrupted";
		  }
	);

export type ConversationAction =
	| ConversationEvent
	| {
			type: "local_user_submit";
			clientMessageId: string;
			text: string;
			images?: ChatConversationImage[];
			timestampMs: number;
			replyRunwayPx?: number;
			appendMessage?: boolean;
	  }
	| {
			type: "local_user_queue";
			clientMessageId: string;
			text: string;
			images?: ChatConversationImage[];
			queueKind: "steer" | "follow_up";
			timestampMs: number;
	  }
	| { type: "local_user_queue_failed"; clientMessageId: string }
	| {
			type: "local_assistant_pending";
			timestampMs: number;
			replyRunwayPx?: number;
	  }
	| {
			type: "local_turn_abort";
			timestampMs: number;
	  }
	| {
			type: "conversation_runtime_error";
			message: string;
			timestampMs: number;
	  };

export type ConversationState = {
	messages: ChatMessage[];
	active: {
		assistantMessageId?: string;
		turnStartedAtMs?: number;
		assistantUpdatedAtMs?: number;
		firstRuntimeUserSeen: boolean;
	} | null;
	pendingUsers: Array<{
		clientMessageId: string;
		text: string;
		images?: ChatConversationImage[];
		timestampMs?: number;
		queueKind?: "steer" | "follow_up";
	}>;
};

export type ConversationReducerContext = {
	createMessageId: (kind: "user" | "assistant" | "compaction") => string;
	createContentId: (kind: "text" | "thinking") => string;
	now: () => number;
	formatTime: (timestampMs: number) => string;
};
