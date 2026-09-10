use serde_json::Value;

use super::events::{RuntimeErrorCode, RuntimeEvent};

#[derive(Default)]
pub struct PiEventAdapter {
    finalized_text: String,
    stop_reason: Option<String>,
    error_message: Option<String>,
}

impl PiEventAdapter {
    pub fn adapt(&mut self, generation: u64, message: &Value) -> Vec<RuntimeEvent> {
        match message.get("type").and_then(Value::as_str) {
            Some("message_start") => self.adapt_message_start(generation, message),
            Some("message_update") => adapt_message_update(generation, message),
            Some("message_end") => self.adapt_message_end(generation, message),
            Some("tool_execution_start") => adapt_tool_execution_start(generation, message),
            Some("tool_execution_update") => adapt_tool_execution_update(generation, message),
            Some("tool_execution_end") => adapt_tool_execution_end(generation, message),
            Some("queue_update") => adapt_queue_update(generation, message),
            Some("agent_end") => {
                self.remember_agent_end(message);
                Vec::new()
            }
            Some("agent_settled") => self.adapt_agent_settled(generation),
            Some("response")
                if message.get("success").and_then(Value::as_bool) == Some(false)
                    && !is_pilo_correlated_response(message) =>
            {
                vec![RuntimeEvent::RuntimeError {
                    generation,
                    code: RuntimeErrorCode::RpcResponse,
                    message: message
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Pi RPC command failed")
                        .to_owned(),
                }]
            }
            _ => Vec::new(),
        }
    }

    fn adapt_message_start(&mut self, generation: u64, event: &Value) -> Vec<RuntimeEvent> {
        let Some(message) = event.get("message") else {
            return Vec::new();
        };
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => vec![RuntimeEvent::AssistantMessageStart { generation }],
            Some("user") => {
                self.finalized_text.clear();
                self.stop_reason = None;
                self.error_message = None;
                message_text(message)
                    .filter(|text| !text.is_empty())
                    .map(|text| RuntimeEvent::UserMessageStart { generation, text })
                    .into_iter()
                    .collect()
            }
            _ => Vec::new(),
        }
    }

    fn adapt_message_end(&mut self, generation: u64, event: &Value) -> Vec<RuntimeEvent> {
        let Some(message) = event.get("message") else {
            return Vec::new();
        };
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            return Vec::new();
        }

        self.remember_completion_metadata(message);
        let Some(text) = assistant_text(message) else {
            return Vec::new();
        };
        self.finalized_text.push_str(&text);

        vec![RuntimeEvent::AssistantTextSnapshot {
            generation,
            text: self.finalized_text.clone(),
        }]
    }

    fn remember_agent_end(&mut self, event: &Value) {
        let assistant = event
            .get("messages")
            .and_then(Value::as_array)
            .and_then(|messages| {
                messages
                    .iter()
                    .rev()
                    .find(|entry| entry.get("role").and_then(Value::as_str) == Some("assistant"))
            });
        if let Some(assistant) = assistant {
            self.remember_completion_metadata(assistant);
        }
    }

    fn remember_completion_metadata(&mut self, message: &Value) {
        self.stop_reason = message
            .get("stopReason")
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.error_message = message
            .get("errorMessage")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }

    fn adapt_agent_settled(&mut self, generation: u64) -> Vec<RuntimeEvent> {
        let event = RuntimeEvent::AssistantMessageEnd {
            generation,
            stop_reason: self.stop_reason.take(),
            error_message: self.error_message.take(),
        };
        self.finalized_text.clear();
        vec![event]
    }
}

fn is_pilo_correlated_response(message: &Value) -> bool {
    message
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| id.starts_with("pilo-"))
}

fn adapt_queue_update(generation: u64, message: &Value) -> Vec<RuntimeEvent> {
    vec![RuntimeEvent::QueueUpdate {
        generation,
        steering: string_array(message.get("steering")),
        follow_up: string_array(message.get("followUp")),
    }]
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn message_text(message: &Value) -> Option<String> {
    match message.get("content")? {
        Value::String(text) => Some(text.clone()),
        Value::Array(content) => {
            let mut text = String::new();
            for block in content {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(value) = block.get("text").and_then(Value::as_str) {
                        text.push_str(value);
                    }
                }
            }
            Some(text)
        }
        _ => None,
    }
}

fn adapt_message_update(generation: u64, message: &Value) -> Vec<RuntimeEvent> {
    let Some(event) = message.get("assistantMessageEvent") else {
        return Vec::new();
    };
    match event.get("type").and_then(Value::as_str) {
        Some("text_delta") => event
            .get("delta")
            .and_then(Value::as_str)
            .filter(|delta| !delta.is_empty())
            .map(|delta| RuntimeEvent::AssistantTextDelta {
                generation,
                delta: delta.to_owned(),
            })
            .into_iter()
            .collect(),
        Some("thinking_start") => vec![RuntimeEvent::AssistantThinkingStart { generation }],
        Some("thinking_delta") => event
            .get("delta")
            .and_then(Value::as_str)
            .filter(|delta| !delta.is_empty())
            .map(|delta| RuntimeEvent::AssistantThinkingDelta {
                generation,
                delta: delta.to_owned(),
            })
            .into_iter()
            .collect(),
        Some("thinking_end") => vec![RuntimeEvent::AssistantThinkingEnd { generation }],
        _ => Vec::new(),
    }
}

fn adapt_tool_execution_start(generation: u64, message: &Value) -> Vec<RuntimeEvent> {
    let Some(tool_call_id) = message.get("toolCallId").and_then(Value::as_str) else {
        return Vec::new();
    };
    let Some(tool_name) = message.get("toolName").and_then(Value::as_str) else {
        return Vec::new();
    };

    vec![RuntimeEvent::ToolExecutionStart {
        generation,
        tool_call_id: tool_call_id.to_owned(),
        tool_name: tool_name.to_owned(),
        args: message.get("args").cloned().unwrap_or(Value::Null),
    }]
}

fn adapt_tool_execution_update(generation: u64, message: &Value) -> Vec<RuntimeEvent> {
    let Some(tool_call_id) = message.get("toolCallId").and_then(Value::as_str) else {
        return Vec::new();
    };
    let Some(tool_name) = message.get("toolName").and_then(Value::as_str) else {
        return Vec::new();
    };

    vec![RuntimeEvent::ToolExecutionUpdate {
        generation,
        tool_call_id: tool_call_id.to_owned(),
        tool_name: tool_name.to_owned(),
        args: message.get("args").cloned().unwrap_or(Value::Null),
        partial_result: message.get("partialResult").cloned().unwrap_or(Value::Null),
    }]
}

fn adapt_tool_execution_end(generation: u64, message: &Value) -> Vec<RuntimeEvent> {
    let Some(tool_call_id) = message.get("toolCallId").and_then(Value::as_str) else {
        return Vec::new();
    };
    let Some(tool_name) = message.get("toolName").and_then(Value::as_str) else {
        return Vec::new();
    };

    vec![RuntimeEvent::ToolExecutionEnd {
        generation,
        tool_call_id: tool_call_id.to_owned(),
        tool_name: tool_name.to_owned(),
        result: message.get("result").cloned().unwrap_or(Value::Null),
        is_error: message
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }]
}

fn assistant_text(message: &Value) -> Option<String> {
    let content = message.get("content")?.as_array()?;
    let mut text = String::new();
    for block in content {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(value) = block.get("text").and_then(Value::as_str) {
                text.push_str(value);
            }
        }
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_assistant_message_start_instead_of_agent_start() {
        let mut adapter = PiEventAdapter::default();
        assert!(adapter
            .adapt(3, &serde_json::json!({ "type": "agent_start" }))
            .is_empty());
        assert_eq!(
            adapter.adapt(
                3,
                &serde_json::json!({
                    "type": "message_start",
                    "message": { "role": "assistant", "content": [] }
                })
            ),
            [RuntimeEvent::AssistantMessageStart { generation: 3 }]
        );
    }

    #[test]
    fn maps_text_delta_without_exposing_raw_message() {
        let mut adapter = PiEventAdapter::default();
        let events = adapter.adapt(
            4,
            &serde_json::json!({
                "type": "message_update",
                "usage": { "input": 1, "output": 2 },
                "assistantMessageEvent": {
                    "type": "text_delta",
                    "contentIndex": 0,
                    "delta": "hello"
                }
            }),
        );

        assert_eq!(
            events,
            [RuntimeEvent::AssistantTextDelta {
                generation: 4,
                delta: "hello".to_owned(),
            }]
        );
    }

    #[test]
    fn reconciles_authoritative_text_across_assistant_messages() {
        let mut adapter = PiEventAdapter::default();
        assert_eq!(
            adapter.adapt(
                4,
                &serde_json::json!({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [
                            { "type": "text", "text": "before tool" },
                            { "type": "toolCall", "id": "call-1", "name": "bash", "arguments": {} }
                        ],
                        "stopReason": "toolUse"
                    }
                })
            ),
            [RuntimeEvent::AssistantTextSnapshot {
                generation: 4,
                text: "before tool".to_owned(),
            }]
        );
        assert_eq!(
            adapter.adapt(
                4,
                &serde_json::json!({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{ "type": "text", "text": " after tool" }],
                        "stopReason": "stop"
                    }
                })
            ),
            [RuntimeEvent::AssistantTextSnapshot {
                generation: 4,
                text: "before tool after tool".to_owned(),
            }]
        );
    }

    #[test]
    fn user_message_start_begins_a_new_conversation_turn() {
        let mut adapter = PiEventAdapter::default();
        assert_eq!(
            adapter.adapt(
                4,
                &serde_json::json!({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{ "type": "text", "text": "first reply" }],
                        "stopReason": "stop"
                    }
                })
            ),
            [RuntimeEvent::AssistantTextSnapshot {
                generation: 4,
                text: "first reply".to_owned(),
            }]
        );
        assert_eq!(
            adapter.adapt(
                4,
                &serde_json::json!({
                    "type": "message_start",
                    "message": {
                        "role": "user",
                        "content": [{ "type": "text", "text": "follow up" }]
                    }
                })
            ),
            [RuntimeEvent::UserMessageStart {
                generation: 4,
                text: "follow up".to_owned(),
            }]
        );
        assert_eq!(
            adapter.adapt(
                4,
                &serde_json::json!({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{ "type": "text", "text": "second reply" }],
                        "stopReason": "stop"
                    }
                })
            ),
            [RuntimeEvent::AssistantTextSnapshot {
                generation: 4,
                text: "second reply".to_owned(),
            }]
        );
    }

    #[test]
    fn maps_queue_update_for_follow_up_ui() {
        let mut adapter = PiEventAdapter::default();
        assert_eq!(
            adapter.adapt(
                7,
                &serde_json::json!({
                    "type": "queue_update",
                    "steering": ["change direction"],
                    "followUp": ["then summarize", "then test"]
                })
            ),
            [RuntimeEvent::QueueUpdate {
                generation: 7,
                steering: vec!["change direction".to_owned()],
                follow_up: vec!["then summarize".to_owned(), "then test".to_owned()],
            }]
        );
    }

    #[test]
    fn maps_thinking_stream_lifecycle() {
        let mut adapter = PiEventAdapter::default();
        assert_eq!(
            adapter.adapt(
                4,
                &serde_json::json!({
                    "type": "message_update",
                    "assistantMessageEvent": { "type": "thinking_start", "contentIndex": 0 }
                })
            ),
            [RuntimeEvent::AssistantThinkingStart { generation: 4 }]
        );
        assert_eq!(
            adapter.adapt(
                4,
                &serde_json::json!({
                    "type": "message_update",
                    "assistantMessageEvent": {
                        "type": "thinking_delta",
                        "contentIndex": 0,
                        "delta": "considering"
                    }
                })
            ),
            [RuntimeEvent::AssistantThinkingDelta {
                generation: 4,
                delta: "considering".to_owned(),
            }]
        );
        assert_eq!(
            adapter.adapt(
                4,
                &serde_json::json!({
                    "type": "message_update",
                    "assistantMessageEvent": { "type": "thinking_end", "contentIndex": 0 }
                })
            ),
            [RuntimeEvent::AssistantThinkingEnd { generation: 4 }]
        );
    }

    #[test]
    fn maps_tool_execution_lifecycle_with_update_args() {
        let mut adapter = PiEventAdapter::default();
        assert_eq!(
            adapter.adapt(
                8,
                &serde_json::json!({
                    "type": "tool_execution_start",
                    "toolCallId": "call-1",
                    "toolName": "bash",
                    "args": { "command": "pwd" }
                })
            ),
            [RuntimeEvent::ToolExecutionStart {
                generation: 8,
                tool_call_id: "call-1".to_owned(),
                tool_name: "bash".to_owned(),
                args: serde_json::json!({ "command": "pwd" }),
            }]
        );
        assert_eq!(
            adapter.adapt(
                8,
                &serde_json::json!({
                    "type": "tool_execution_update",
                    "toolCallId": "call-1",
                    "toolName": "bash",
                    "args": { "command": "pwd" },
                    "partialResult": { "content": [{ "type": "text", "text": "/repo" }] }
                })
            ),
            [RuntimeEvent::ToolExecutionUpdate {
                generation: 8,
                tool_call_id: "call-1".to_owned(),
                tool_name: "bash".to_owned(),
                args: serde_json::json!({ "command": "pwd" }),
                partial_result: serde_json::json!({
                    "content": [{ "type": "text", "text": "/repo" }]
                }),
            }]
        );
    }

    #[test]
    fn agent_end_does_not_finish_until_agent_settled() {
        let mut adapter = PiEventAdapter::default();
        assert!(adapter
            .adapt(
                5,
                &serde_json::json!({
                    "type": "agent_end",
                    "willRetry": false,
                    "messages": [{
                        "role": "assistant",
                        "content": [],
                        "stopReason": "toolUse"
                    }]
                })
            )
            .is_empty());

        assert_eq!(
            adapter.adapt(
                5,
                &serde_json::json!({
                    "type": "agent_end",
                    "willRetry": false,
                    "messages": [{
                        "role": "assistant",
                        "content": [],
                        "stopReason": "stop"
                    }]
                })
            ),
            []
        );

        assert_eq!(
            adapter.adapt(5, &serde_json::json!({ "type": "agent_settled" })),
            [RuntimeEvent::AssistantMessageEnd {
                generation: 5,
                stop_reason: Some("stop".to_owned()),
                error_message: None,
            }]
        );
    }

    #[test]
    fn settled_uses_latest_error_metadata_and_resets_state() {
        let mut adapter = PiEventAdapter::default();
        assert!(adapter
            .adapt(
                5,
                &serde_json::json!({
                    "type": "agent_end",
                    "messages": [{
                        "role": "assistant",
                        "content": [],
                        "stopReason": "error",
                        "errorMessage": "provider failed"
                    }]
                })
            )
            .is_empty());
        assert_eq!(
            adapter.adapt(5, &serde_json::json!({ "type": "agent_settled" })),
            [RuntimeEvent::AssistantMessageEnd {
                generation: 5,
                stop_reason: Some("error".to_owned()),
                error_message: Some("provider failed".to_owned()),
            }]
        );
        assert_eq!(
            adapter.adapt(5, &serde_json::json!({ "type": "agent_settled" })),
            [RuntimeEvent::AssistantMessageEnd {
                generation: 5,
                stop_reason: None,
                error_message: None,
            }]
        );
    }

    #[test]
    fn maps_failed_rpc_response_to_runtime_error() {
        let mut adapter = PiEventAdapter::default();
        let events = adapter.adapt(
            6,
            &serde_json::json!({
                "type": "response",
                "command": "prompt",
                "success": false,
                "error": "Agent is already streaming"
            }),
        );

        assert_eq!(
            events,
            [RuntimeEvent::RuntimeError {
                generation: 6,
                code: RuntimeErrorCode::RpcResponse,
                message: "Agent is already streaming".to_owned(),
            }]
        );
    }

    #[test]
    fn correlated_rpc_failure_is_handled_by_the_request_caller() {
        let mut adapter = PiEventAdapter::default();
        assert!(adapter
            .adapt(
                6,
                &serde_json::json!({
                    "id": "pilo-123-1",
                    "type": "response",
                    "command": "follow_up",
                    "success": false,
                    "error": "Extension commands cannot be queued"
                })
            )
            .is_empty());
    }
}
