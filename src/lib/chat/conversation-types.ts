import type { TokenUsage } from "@/lib/api/token-usage";
import type { AssistantActivity } from "@/lib/chat/chat-activity-types";
import type {
	AssistantContentItem,
	AssistantPendingStatus,
} from "@/lib/chat/chat-activity-state";

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
			/** null: checking session readiness; undefined: no local submission phase. */
			pendingStatus?: AssistantPendingStatus | null;
			workDurationMs?: number;
			replyRunwayPx?: number;
			stopReason?: string;
			errorMessage?: string;
			/** 当前回复段累计的模型用量（含工具嵌套调用、缓存与费用）。 */
			usage?: TokenUsage;
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
		| { type: "assistant_usage_update"; usage: TokenUsage }
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
				/** 当前回复段累计的模型用量；未上报时可为空或省略。 */
				usage?: TokenUsage | null;
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
			pendingStatus?: AssistantPendingStatus | null;
	  }
	| {
			type: "local_assistant_status";
			clientMessageId: string;
			status?: AssistantPendingStatus;
	  }
	| {
			type: "local_turn_abort";
			timestampMs?: number;
	  }
	| {
			type: "conversation_runtime_error";
			message: string;
			timestampMs?: number;
	  };

export type ConversationState = {
	messages: ChatMessage[];
	active: {
		assistantMessageId?: string;
		localClientMessageId?: string;
		turnStartedAtMs?: number;
		assistantUpdatedAtMs?: number;
		firstRuntimeUserSeen: boolean;
		runtimeStarted?: boolean;
		/**
		 * The reply was adopted mid-turn with no earlier conversation loaded, so it
		 * lacks the turn's earlier content. Host text snapshots cover the whole
		 * turn and must not be reconciled into it.
		 */
		partialTurn?: boolean;
	} | null;
	pendingUsers: Array<{
		clientMessageId: string;
		text: string;
		images?: ChatConversationImage[];
		timestampMs?: number;
		replyStartIndex?: number;
		previousTurn?: ConversationState["active"];
		queueKind?: "steer" | "follow_up";
	}>;
};

export type ConversationReducerContext = {
	createMessageId: (kind: "user" | "assistant" | "compaction") => string;
	createContentId: (kind: "text" | "thinking") => string;
	now: () => number;
	formatTime: (timestampMs: number) => string;
};
