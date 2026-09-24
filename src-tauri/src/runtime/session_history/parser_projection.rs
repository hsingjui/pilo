use serde_json::Value;

use super::parser_fields::{
    entry_id, entry_timestamp_ms, fallback_text, normalize_thinking, tool_result_payload,
    user_images, user_text,
};
use super::types::{ConversationEventDto, SessionHistory, SessionHistoryModel, TurnCompletion};

#[derive(Default)]
struct TurnMeta {
    has_assistant: bool,
    stop_reason: Option<String>,
    error_message: Option<String>,
    updated_at_ms: Option<i64>,
}

pub(super) fn project_branch(entries: &[Value], branch: &[usize]) -> SessionHistory {
    let mut history = SessionHistory::default();
    let mut turn = TurnMeta::default();

    for &index in branch {
        let entry = &entries[index];
        match entry.get("type").and_then(Value::as_str) {
            Some("model_change") => {
                if let (Some(provider), Some(id)) = (
                    entry.get("provider").and_then(Value::as_str),
                    entry.get("modelId").and_then(Value::as_str),
                ) {
                    history.model = Some(SessionHistoryModel {
                        provider: provider.to_owned(),
                        id: id.to_owned(),
                    });
                }
            }
            Some("thinking_level_change") => {
                history.thinking_level = entry
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            Some("session_info") => {
                if let Some(name) = entry.get("name").and_then(Value::as_str) {
                    history.name = Some(name.to_owned());
                }
            }
            Some("message") => {
                let Some(message) = entry.get("message") else {
                    continue;
                };
                history.source_message_count += 1;
                project_message(entry, message, &mut history.events, &mut turn);
            }
            Some("compaction") => {
                finish_turn(&mut history.events, &mut turn, false);
                history.events.push(ConversationEventDto::CompactionMarker {
                    summary: entry
                        .get("summary")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    tokens_before: entry.get("tokensBefore").and_then(Value::as_u64),
                    timestamp_ms: entry_timestamp_ms(entry, None),
                    source_entry_id: entry_id(entry),
                });
            }
            Some("custom_message")
                if entry.get("display").and_then(Value::as_bool) != Some(false) =>
            {
                let timestamp_ms = entry_timestamp_ms(entry, None);
                let source_entry_id = entry_id(entry);
                let text = fallback_text("Custom message", entry.get("content").unwrap_or(entry));
                ensure_assistant_start(
                    &mut history.events,
                    &mut turn,
                    timestamp_ms,
                    source_entry_id.clone(),
                );
                history
                    .events
                    .push(ConversationEventDto::AssistantTextDelta {
                        delta: text,
                        timestamp_ms,
                        source_entry_id,
                        source_content_index: None,
                    });
                turn.updated_at_ms = timestamp_ms.or(turn.updated_at_ms);
            }
            _ => {}
        }
    }

    finish_turn(&mut history.events, &mut turn, true);
    history
}

fn project_message(
    entry: &Value,
    message: &Value,
    events: &mut Vec<ConversationEventDto>,
    turn: &mut TurnMeta,
) {
    let timestamp_ms = entry_timestamp_ms(entry, Some(message));
    let source_entry_id = entry_id(entry);
    match message.get("role").and_then(Value::as_str) {
        // Pi persists structured system-prompt/tool-loadout updates in the session
        // transcript. They affect replay context but are not conversational UI messages.
        Some("system") => {}
        Some("user") => {
            finish_turn(events, turn, false);
            events.push(ConversationEventDto::UserMessageStart {
                text: user_text(message.get("content")),
                images: user_images(
                    message.get("content"),
                    source_entry_id.as_deref().filter(|id| !id.is_empty()),
                ),
                timestamp_ms,
                source_entry_id,
            });
            turn.updated_at_ms = timestamp_ms;
        }
        Some("assistant") => {
            ensure_assistant_start(events, turn, timestamp_ms, source_entry_id.clone());
            project_assistant_content(
                message.get("content"),
                timestamp_ms,
                source_entry_id.clone(),
                events,
            );
            turn.stop_reason = message
                .get("stopReason")
                .and_then(Value::as_str)
                .map(str::to_owned);
            turn.error_message = message
                .get("errorMessage")
                .and_then(Value::as_str)
                .map(str::to_owned);
            turn.updated_at_ms = timestamp_ms.or(turn.updated_at_ms);
        }
        Some("toolResult") => {
            ensure_assistant_start(events, turn, timestamp_ms, source_entry_id.clone());
            let tool_call_id = message
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    source_entry_id
                        .clone()
                        .unwrap_or_else(|| "orphan-tool-result".to_owned())
                });
            let tool_name = message
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            events.push(ConversationEventDto::ToolExecutionEnd {
                tool_call_id,
                tool_name,
                result: tool_result_payload(message),
                is_error: message
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                timestamp_ms,
                source_entry_id,
            });
            turn.updated_at_ms = timestamp_ms.or(turn.updated_at_ms);
        }
        Some("bashExecution") => {
            ensure_assistant_start(events, turn, timestamp_ms, source_entry_id.clone());
            let tool_call_id = source_entry_id
                .clone()
                .unwrap_or_else(|| format!("bash-{}", events.len()));
            events.push(ConversationEventDto::ToolExecutionStart {
                tool_call_id: tool_call_id.clone(),
                tool_name: "bash".to_owned(),
                args: serde_json::json!({ "command": message.get("command").cloned().unwrap_or(Value::Null) }),
                timestamp_ms,
                source_entry_id: source_entry_id.clone(),
                source_content_index: None,
            });
            events.push(ConversationEventDto::ToolExecutionEnd {
                tool_call_id,
                tool_name: "bash".to_owned(),
                result: serde_json::json!({
                    "content": [{ "type": "text", "text": message.get("output").and_then(Value::as_str).unwrap_or("") }],
                    "exitCode": message.get("exitCode").cloned().unwrap_or(Value::Null),
                    "cancelled": message.get("cancelled").cloned().unwrap_or(Value::Null),
                    "truncated": message.get("truncated").cloned().unwrap_or(Value::Null),
                }),
                is_error: message.get("cancelled").and_then(Value::as_bool) == Some(true)
                    || message.get("exitCode").and_then(Value::as_i64).is_some_and(|code| code != 0),
                timestamp_ms,
                source_entry_id,
            });
            turn.updated_at_ms = timestamp_ms.or(turn.updated_at_ms);
        }
        _ => {
            ensure_assistant_start(events, turn, timestamp_ms, source_entry_id.clone());
            events.push(ConversationEventDto::AssistantTextDelta {
                delta: fallback_text("Unrecognized Session message", message),
                timestamp_ms,
                source_entry_id,
                source_content_index: None,
            });
            turn.updated_at_ms = timestamp_ms.or(turn.updated_at_ms);
        }
    }
}

fn project_assistant_content(
    content: Option<&Value>,
    timestamp_ms: Option<i64>,
    source_entry_id: Option<String>,
    events: &mut Vec<ConversationEventDto>,
) {
    match content {
        Some(Value::Array(parts)) => {
            for (index, part) in parts.iter().enumerate() {
                project_assistant_part(part, index, timestamp_ms, source_entry_id.clone(), events);
            }
        }
        Some(Value::String(text)) => events.push(ConversationEventDto::AssistantTextDelta {
            delta: text.clone(),
            timestamp_ms,
            source_entry_id,
            source_content_index: Some(0),
        }),
        Some(Value::Null) | None => {}
        Some(value) => project_assistant_part(value, 0, timestamp_ms, source_entry_id, events),
    }
}

fn project_assistant_part(
    part: &Value,
    index: usize,
    timestamp_ms: Option<i64>,
    source_entry_id: Option<String>,
    events: &mut Vec<ConversationEventDto>,
) {
    let source_content_index = Some(index);
    match part.get("type").and_then(Value::as_str) {
        Some("text") => {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                events.push(ConversationEventDto::AssistantTextDelta {
                    delta: text.to_owned(),
                    timestamp_ms,
                    source_entry_id,
                    source_content_index,
                });
            }
        }
        Some("thinking") => {
            let text = part
                .get("thinking")
                .or_else(|| part.get("text"))
                .and_then(Value::as_str)
                .map(normalize_thinking)
                .unwrap_or_else(|| fallback_text("Unrecognized thinking content", part));
            events.push(ConversationEventDto::AssistantThinkingStart {
                timestamp_ms,
                source_entry_id: source_entry_id.clone(),
                source_content_index,
            });
            events.push(ConversationEventDto::AssistantThinkingDelta {
                delta: text,
                timestamp_ms,
                source_entry_id: source_entry_id.clone(),
                source_content_index,
            });
            events.push(ConversationEventDto::AssistantThinkingEnd {
                timestamp_ms,
                source_entry_id,
                source_content_index,
            });
        }
        Some("toolCall") => {
            let tool_call_id = part
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!(
                        "{}:tool:{index}",
                        source_entry_id.as_deref().unwrap_or("history")
                    )
                });
            events.push(ConversationEventDto::ToolExecutionStart {
                tool_call_id,
                tool_name: part
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned(),
                args: part.get("arguments").cloned().unwrap_or(Value::Null),
                timestamp_ms,
                source_entry_id,
                source_content_index,
            });
        }
        Some("image") => {
            let mime = part
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("image");
            events.push(ConversationEventDto::AssistantTextDelta {
                delta: format!("[Image content: {mime}]"),
                timestamp_ms,
                source_entry_id,
                source_content_index,
            });
        }
        _ => events.push(ConversationEventDto::AssistantTextDelta {
            delta: fallback_text("Unrecognized Assistant content", part),
            timestamp_ms,
            source_entry_id,
            source_content_index,
        }),
    }
}

fn ensure_assistant_start(
    events: &mut Vec<ConversationEventDto>,
    turn: &mut TurnMeta,
    timestamp_ms: Option<i64>,
    source_entry_id: Option<String>,
) {
    if !turn.has_assistant {
        events.push(ConversationEventDto::AssistantMessageStart {
            timestamp_ms,
            source_entry_id,
        });
        turn.has_assistant = true;
    }
    turn.updated_at_ms = timestamp_ms.or(turn.updated_at_ms);
}

fn finish_turn(events: &mut Vec<ConversationEventDto>, turn: &mut TurnMeta, eof: bool) {
    if !turn.has_assistant {
        *turn = TurnMeta::default();
        return;
    }
    let completion = if eof && !is_terminal_stop_reason(turn.stop_reason.as_deref()) {
        TurnCompletion::Interrupted
    } else {
        TurnCompletion::Complete
    };
    events.push(ConversationEventDto::AssistantTurnEnd {
        stop_reason: turn.stop_reason.take(),
        error_message: turn.error_message.take(),
        completion,
        timestamp_ms: turn.updated_at_ms,
    });
    *turn = TurnMeta::default();
}

fn is_terminal_stop_reason(reason: Option<&str>) -> bool {
    matches!(reason, Some("stop" | "length" | "error" | "aborted"))
}
