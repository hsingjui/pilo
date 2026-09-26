use serde_json::{Value, json};

use super::RuntimeEvent;

pub(super) fn traceable_runtime_event(event: &RuntimeEvent) -> Option<(&'static str, Value)> {
    match event {
        RuntimeEvent::ProcessState { generation, state } => Some((
            "process_state",
            json!({ "generation": generation, "state": state }),
        )),
        RuntimeEvent::RpcMessage {
            generation,
            message,
        } if message.get("type").and_then(Value::as_str) == Some("response") => Some((
            "rpc_message",
            json!({
                "generation": generation,
                "id": message.get("id"),
                "command": message.get("command"),
                "success": message.get("success"),
            }),
        )),
        RuntimeEvent::UserMessageStart { generation, .. } => {
            Some(("user_message_start", json!({ "generation": generation })))
        }
        RuntimeEvent::AssistantMessageStart { generation } => Some((
            "assistant_message_start",
            json!({ "generation": generation }),
        )),
        RuntimeEvent::AssistantMessageEnd {
            generation,
            stop_reason,
            error_message,
        } => Some((
            "assistant_message_end",
            json!({
                "generation": generation,
                "stopReason": stop_reason,
                "hasError": error_message.as_ref().is_some_and(|value| !value.is_empty()),
            }),
        )),
        RuntimeEvent::ToolExecutionStart {
            generation,
            tool_call_id,
            tool_name,
            ..
        } => Some((
            "tool_execution_start",
            json!({
                "generation": generation,
                "toolCallId": tool_call_id,
                "toolName": tool_name,
            }),
        )),
        RuntimeEvent::ToolExecutionEnd {
            generation,
            tool_call_id,
            tool_name,
            is_error,
            ..
        } => Some((
            "tool_execution_end",
            json!({
                "generation": generation,
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "isError": is_error,
            }),
        )),
        RuntimeEvent::QueueUpdate {
            generation,
            steering,
            follow_up,
        } => Some((
            "queue_update",
            json!({
                "generation": generation,
                "steering": steering.len(),
                "followUp": follow_up.len(),
            }),
        )),
        RuntimeEvent::CompactionStart { generation, reason } => Some((
            "compaction_start",
            json!({ "generation": generation, "reason": reason }),
        )),
        RuntimeEvent::CompactionEnd {
            generation,
            reason,
            aborted,
            will_retry,
            ..
        } => Some((
            "compaction_end",
            json!({
                "generation": generation,
                "reason": reason,
                "aborted": aborted,
                "willRetry": will_retry,
            }),
        )),
        RuntimeEvent::AutoRetryStart {
            generation,
            attempt,
            max_attempts,
            ..
        } => Some((
            "auto_retry_start",
            json!({
                "generation": generation,
                "attempt": attempt,
                "maxAttempts": max_attempts,
            }),
        )),
        RuntimeEvent::AutoRetryEnd {
            generation,
            success,
            attempt,
            ..
        } => Some((
            "auto_retry_end",
            json!({
                "generation": generation,
                "success": success,
                "attempt": attempt,
            }),
        )),
        RuntimeEvent::RuntimeError {
            generation,
            code,
            message,
        } => Some((
            "runtime_error",
            json!({
                "generation": generation,
                "code": code,
                "message": message,
            }),
        )),
        _ => None,
    }
}
