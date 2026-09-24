use serde_json::Value;

use super::events::{ExtensionUiRequestPayload, RuntimeEvent};

pub(super) fn is_pilo_correlated_response(message: &Value) -> bool {
    message
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| id.starts_with("pilo-"))
}

pub(super) fn adapt_queue_update(generation: u64, message: &Value) -> Vec<RuntimeEvent> {
    vec![RuntimeEvent::QueueUpdate {
        generation,
        steering: string_array(message.get("steering")),
        follow_up: string_array(message.get("followUp")),
    }]
}

pub(super) fn adapt_compaction_start(generation: u64, message: &Value) -> Vec<RuntimeEvent> {
    vec![RuntimeEvent::CompactionStart {
        generation,
        reason: string_field(message, "reason").unwrap_or_else(|| "manual".to_owned()),
    }]
}

pub(super) fn adapt_compaction_end(generation: u64, message: &Value) -> Vec<RuntimeEvent> {
    vec![RuntimeEvent::CompactionEnd {
        generation,
        reason: string_field(message, "reason").unwrap_or_else(|| "manual".to_owned()),
        result: message
            .get("result")
            .filter(|value| !value.is_null())
            .cloned(),
        aborted: message
            .get("aborted")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        will_retry: message
            .get("willRetry")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        error_message: string_field(message, "errorMessage"),
    }]
}

pub(super) fn adapt_auto_retry_start(generation: u64, message: &Value) -> Vec<RuntimeEvent> {
    vec![RuntimeEvent::AutoRetryStart {
        generation,
        attempt: u64_field(message, "attempt"),
        max_attempts: u64_field(message, "maxAttempts"),
        delay_ms: u64_field(message, "delayMs"),
        error_message: string_field(message, "errorMessage").unwrap_or_default(),
    }]
}

pub(super) fn adapt_auto_retry_end(generation: u64, message: &Value) -> Vec<RuntimeEvent> {
    vec![RuntimeEvent::AutoRetryEnd {
        generation,
        success: message
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        attempt: u64_field(message, "attempt"),
        final_error: string_field(message, "finalError"),
    }]
}

pub(super) fn adapt_summarization_retry_scheduled(
    generation: u64,
    message: &Value,
) -> Vec<RuntimeEvent> {
    vec![RuntimeEvent::SummarizationRetryScheduled {
        generation,
        attempt: u64_field(message, "attempt"),
        max_attempts: u64_field(message, "maxAttempts"),
        delay_ms: u64_field(message, "delayMs"),
        error_message: string_field(message, "errorMessage").unwrap_or_default(),
    }]
}

pub(super) fn adapt_summarization_retry_attempt_start(
    generation: u64,
    message: &Value,
) -> Vec<RuntimeEvent> {
    vec![RuntimeEvent::SummarizationRetryAttemptStart {
        generation,
        source: string_field(message, "source").unwrap_or_else(|| "compaction".to_owned()),
        reason: string_field(message, "reason"),
    }]
}

pub(super) fn adapt_extension_ui_request(generation: u64, message: &Value) -> Vec<RuntimeEvent> {
    let Some(id) = string_field(message, "id") else {
        return Vec::new();
    };
    let Some(method) = string_field(message, "method") else {
        return Vec::new();
    };
    vec![RuntimeEvent::ExtensionUiRequest {
        generation,
        request: Box::new(ExtensionUiRequestPayload {
            id,
            method,
            title: string_field(message, "title"),
            message: string_field(message, "message"),
            options: string_array(message.get("options")),
            placeholder: string_field(message, "placeholder"),
            prefill: string_field(message, "prefill"),
            timeout: optional_u64_field(message, "timeout"),
            notify_type: string_field(message, "notifyType"),
            status_key: string_field(message, "statusKey"),
            status_text: string_field(message, "statusText"),
            widget_key: string_field(message, "widgetKey"),
            widget_lines: message
                .get("widgetLines")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                }),
            widget_placement: string_field(message, "widgetPlacement"),
            text: string_field(message, "text"),
        }),
    }]
}

fn string_field(message: &Value, field: &str) -> Option<String> {
    message
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn optional_u64_field(message: &Value, field: &str) -> Option<u64> {
    message.get(field).and_then(Value::as_u64)
}

fn u64_field(message: &Value, field: &str) -> u64 {
    optional_u64_field(message, field).unwrap_or_default()
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

pub(super) fn message_text(message: &Value) -> Option<String> {
    match message.get("content")? {
        Value::String(text) => Some(text.clone()),
        Value::Array(content) => {
            let mut text = String::new();
            for block in content {
                if block.get("type").and_then(Value::as_str) == Some("text")
                    && let Some(value) = block.get("text").and_then(Value::as_str)
                {
                    text.push_str(value);
                }
            }
            Some(text)
        }
        _ => None,
    }
}

pub(super) fn adapt_message_update(generation: u64, message: &Value) -> Vec<RuntimeEvent> {
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

pub(super) fn adapt_tool_execution_start(generation: u64, message: &Value) -> Vec<RuntimeEvent> {
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

pub(super) fn adapt_tool_execution_update(generation: u64, message: &Value) -> Vec<RuntimeEvent> {
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

pub(super) fn adapt_tool_execution_end(generation: u64, message: &Value) -> Vec<RuntimeEvent> {
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

pub(super) fn assistant_text(message: &Value) -> Option<String> {
    let content = message.get("content")?.as_array()?;
    let mut text = String::new();
    for block in content {
        if block.get("type").and_then(Value::as_str) == Some("text")
            && let Some(value) = block.get("text").and_then(Value::as_str)
        {
            text.push_str(value);
        }
    }
    Some(text)
}
