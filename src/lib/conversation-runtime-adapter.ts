import type { ConversationAction } from "@/lib/conversation-types";
import type { PiloRuntimeEvent } from "@/lib/pi-runtime";

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
			};
		case "process_state":
		case "rpc_message":
		case "queue_update":
		case "runtime_log":
		case "runtime_error":
			return null;
	}
}
