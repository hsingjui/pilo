use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::types::{
    ConversationEventDto, SessionHistory, SessionHistoryModel, SessionHistoryStats, TurnCompletion,
};

#[derive(Default)]
struct TurnMeta {
    has_assistant: bool,
    stop_reason: Option<String>,
    error_message: Option<String>,
    updated_at_ms: Option<i64>,
}

#[derive(Default)]
pub(super) struct HistoryParser {
    entries: Vec<Value>,
    partial_line: Vec<u8>,
}

impl HistoryParser {
    pub(super) fn push(&mut self, mut bytes: &[u8]) {
        if !self.partial_line.is_empty() {
            let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') else {
                self.partial_line.extend_from_slice(bytes);
                return;
            };
            self.partial_line.extend_from_slice(&bytes[..newline]);
            push_entry(&mut self.entries, &self.partial_line);
            self.partial_line.clear();
            bytes = &bytes[newline + 1..];
        }

        let mut start = 0;
        for (index, byte) in bytes.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            push_entry(&mut self.entries, &bytes[start..index]);
            start = index + 1;
        }
        if start < bytes.len() {
            self.partial_line.extend_from_slice(&bytes[start..]);
        }
    }

    pub(super) fn finish(mut self) -> SessionHistory {
        if !self.partial_line.is_empty() {
            push_entry(&mut self.entries, &self.partial_line);
        }
        parse_history_entries(&self.entries)
    }
}

#[cfg(test)]
pub(super) fn parse_history(bytes: &[u8]) -> SessionHistory {
    let mut parser = HistoryParser::default();
    parser.push(bytes);
    parser.finish()
}

fn push_entry(entries: &mut Vec<Value>, line: &[u8]) {
    if line.is_empty() {
        return;
    }
    if let Ok(value) = serde_json::from_slice::<Value>(line) {
        entries.push(value);
    }
}

fn active_branch_indices(entries: &[Value]) -> Vec<usize> {
    let mut by_id = HashMap::<&str, usize>::new();
    let mut leaf = None;
    for (index, entry) in entries.iter().enumerate() {
        if let Some(id) = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            by_id.insert(id, index);
            leaf = Some(index);
        }
    }
    let Some(mut current) = leaf else {
        return (0..entries.len()).collect();
    };

    let mut indices = Vec::new();
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current) {
            break;
        }
        indices.push(current);
        let Some(parent_id) = entries[current].get("parentId").and_then(Value::as_str) else {
            break;
        };
        let Some(parent) = by_id.get(parent_id).copied() else {
            break;
        };
        current = parent;
    }
    indices.reverse();

    if let Some(header) = entries.first()
        && header.get("type").and_then(Value::as_str) == Some("session")
        && header.get("id").is_none()
    {
        indices.insert(0, 0);
    }
    indices
}

fn parse_history_entries(entries: &[Value]) -> SessionHistory {
    let branch = active_branch_indices(entries);
    let mut history = project_branch(entries, &branch);
    history.stats = collect_history_stats(entries, &branch);
    history
}

fn collect_history_stats(entries: &[Value], branch: &[usize]) -> SessionHistoryStats {
    let mut stats = SessionHistoryStats::default();

    for entry in entries {
        match entry.get("type").and_then(Value::as_str) {
            Some("message") => {
                let Some(message) = entry.get("message") else {
                    continue;
                };
                stats.total_messages += 1;
                match message.get("role").and_then(Value::as_str) {
                    Some("user") => stats.user_messages += 1,
                    Some("toolResult") => {
                        stats.tool_results += 1;
                        add_usage(&mut stats, message.get("usage"));
                    }
                    Some("assistant") => {
                        stats.assistant_messages += 1;
                        stats.tool_calls += message
                            .get("content")
                            .and_then(Value::as_array)
                            .map(|content| {
                                content
                                    .iter()
                                    .filter(|item| {
                                        item.get("type").and_then(Value::as_str) == Some("toolCall")
                                    })
                                    .count()
                            })
                            .unwrap_or(0);
                        add_usage(&mut stats, message.get("usage"));
                    }
                    _ => {}
                }
            }
            Some("branch_summary") | Some("compaction") => {
                add_usage(&mut stats, entry.get("usage"));
            }
            _ => {}
        }
    }

    stats.context_tokens = current_branch_context_tokens(entries, branch);
    stats
}

fn add_usage(stats: &mut SessionHistoryStats, usage: Option<&Value>) {
    let Some(usage) = usage else {
        return;
    };
    let input = usage.get("input").and_then(Value::as_u64).unwrap_or(0);
    let output = usage.get("output").and_then(Value::as_u64).unwrap_or(0);
    let cache_read = usage.get("cacheRead").and_then(Value::as_u64).unwrap_or(0);
    let cache_write = usage.get("cacheWrite").and_then(Value::as_u64).unwrap_or(0);

    stats.tokens.input = stats.tokens.input.saturating_add(input);
    stats.tokens.output = stats.tokens.output.saturating_add(output);
    stats.tokens.cache_read = stats.tokens.cache_read.saturating_add(cache_read);
    stats.tokens.cache_write = stats.tokens.cache_write.saturating_add(cache_write);
    stats.tokens.total = stats.tokens.total.saturating_add(
        input
            .saturating_add(output)
            .saturating_add(cache_read)
            .saturating_add(cache_write),
    );
    stats.cost += usage
        .get("cost")
        .and_then(|cost| cost.get("total"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
}

fn current_branch_context_tokens(entries: &[Value], branch: &[usize]) -> Option<u64> {
    let start = branch
        .iter()
        .rposition(|index| {
            entries[*index].get("type").and_then(Value::as_str) == Some("compaction")
        })
        .map(|position| position + 1)
        .unwrap_or(0);

    for index in branch[start..].iter().rev() {
        let entry = &entries[*index];
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = entry.get("message") else {
            continue;
        };
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if matches!(
            message.get("stopReason").and_then(Value::as_str),
            Some("aborted" | "error")
        ) {
            continue;
        }
        let Some(usage) = message.get("usage") else {
            continue;
        };
        let total = usage
            .get("totalTokens")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| {
                ["input", "output", "cacheRead", "cacheWrite"]
                    .into_iter()
                    .filter_map(|key| usage.get(key).and_then(Value::as_u64))
                    .fold(0_u64, u64::saturating_add)
            });
        if total > 0 {
            return Some(total);
        }
    }

    None
}

fn project_branch(entries: &[Value], branch: &[usize]) -> SessionHistory {
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
        Some("user") => {
            finish_turn(events, turn, false);
            events.push(ConversationEventDto::UserMessageStart {
                text: user_text(message.get("content")),
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

fn entry_id(entry: &Value) -> Option<String> {
    entry.get("id").and_then(Value::as_str).map(str::to_owned)
}

fn entry_timestamp_ms(entry: &Value, message: Option<&Value>) -> Option<i64> {
    timestamp_ms(entry.get("timestamp"))
        .or_else(|| message.and_then(|value| timestamp_ms(value.get("timestamp"))))
}

fn timestamp_ms(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number.as_i64(),
        Value::String(value) => OffsetDateTime::parse(value, &Rfc3339)
            .ok()
            .and_then(|value| i64::try_from(value.unix_timestamp_nanos() / 1_000_000).ok()),
        _ => None,
    }
}

fn user_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|part| {
                if let Some(text) = part.as_str() {
                    return text.to_owned();
                }
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    return part
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                }
                if part.get("type").and_then(Value::as_str) == Some("image") {
                    return "[图片]".to_owned();
                }
                fallback_text("User content", part)
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::Null) | None => String::new(),
        Some(value) => fallback_text("User content", value),
    }
}

fn tool_result_payload(message: &Value) -> Value {
    let Some(object) = message.as_object() else {
        return message.clone();
    };
    let mut result = Map::new();
    for (key, value) in object {
        if matches!(
            key.as_str(),
            "role" | "toolCallId" | "toolName" | "isError" | "timestamp"
        ) {
            continue;
        }
        result.insert(key.clone(), value.clone());
    }
    Value::Object(result)
}

fn fallback_text(label: &str, value: &Value) -> String {
    let mut serialized = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
    const MAX_FALLBACK_BYTES: usize = 16 * 1024;
    if serialized.len() > MAX_FALLBACK_BYTES {
        serialized.truncate(MAX_FALLBACK_BYTES);
        serialized.push_str("\n… truncated …");
    }
    format!("{label}\n\n```json\n{serialized}\n```")
}

fn normalize_thinking(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
            continue;
        }
        output.push(ch);
    }
    output
        .strip_prefix("Thinking:")
        .map(str::trim_start)
        .unwrap_or(output.as_str())
        .to_owned()
}
