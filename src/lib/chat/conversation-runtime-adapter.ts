import type { ConversationAction } from "@/lib/chat/conversation-types";
import type { PiloRuntimeEvent } from "@/lib/api/pi-runtime";

export function toConversationAction(
	event: PiloRuntimeEvent,
): ConversationAction | null {
	switch (event.type) {
		case "user_message_start":
			return { type: event.type, text: event.text };
		case "assistant_message_start":
		case "assistant_thinking_start":
		case "assistant_thinking_end":
			return { type: event.type };
		case "assistant_text_delta":
		case "assistant_thinking_delta":
			return { type: event.type, delta: event.delta };
		case "assistant_text_snapshot":
			return { type: event.type, text: event.text };
		case "tool_execution_start":
			return {
				type: event.type,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
		case "tool_execution_update":
			return {
				type: event.type,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
		case "tool_execution_end":
			return {
				type: event.type,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
		case "assistant_message_end":
			return {
				type: "assistant_turn_end",
				stopReason: event.stopReason,
				errorMessage: event.errorMessage,
				usage: event.usage,
			};
		case "theme_settings_changed":
		case "project_model_scope_changed":
		case "next_prompt_settings_changed":
		case "cache_keep_alive_settings_changed":
		case "sessions_indexed":
		case "session_index_error":
		case "session_read_state_changed":
		case "session_turn_completed":
		case "process_state":
		case "rpc_message":
		case "queue_update":
		case "compaction_start":
			return null;
		case "compaction_end":
			return event.result && !event.aborted
				? {
						type: "compaction_marker",
						summary: event.result.summary,
						tokensBefore: event.result.tokensBefore,
					}
				: null;
		case "auto_retry_start":
		case "auto_retry_end":
		case "summarization_retry_scheduled":
		case "summarization_retry_attempt_start":
		case "summarization_retry_finished":
		case "extension_ui_request":
		case "runtime_log":
		case "runtime_error":
			return null;
	}
}
