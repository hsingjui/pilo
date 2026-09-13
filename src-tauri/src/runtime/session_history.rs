use std::collections::{HashMap, VecDeque};

use serde::Serialize;
use serde_json::{Map, Value};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::domain::Project;

use super::server_client::ServerManager;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryModel {
    pub provider: String,
    pub id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistory {
    pub events: Vec<ConversationEventDto>,
    pub model: Option<SessionHistoryModel>,
    pub thinking_level: Option<String>,
    pub name: Option<String>,
    pub source_message_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConversationEventDto {
    UserMessageStart {
        text: String,
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
    },
    AssistantMessageStart {
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
    },
    AssistantTextDelta {
        delta: String,
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
        #[serde(rename = "sourceContentIndex", skip_serializing_if = "Option::is_none")]
        source_content_index: Option<usize>,
    },
    AssistantThinkingStart {
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
        #[serde(rename = "sourceContentIndex", skip_serializing_if = "Option::is_none")]
        source_content_index: Option<usize>,
    },
    AssistantThinkingDelta {
        delta: String,
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
        #[serde(rename = "sourceContentIndex", skip_serializing_if = "Option::is_none")]
        source_content_index: Option<usize>,
    },
    AssistantThinkingEnd {
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
        #[serde(rename = "sourceContentIndex", skip_serializing_if = "Option::is_none")]
        source_content_index: Option<usize>,
    },
    ToolExecutionStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: Value,
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
        #[serde(rename = "sourceContentIndex", skip_serializing_if = "Option::is_none")]
        source_content_index: Option<usize>,
    },
    ToolExecutionEnd {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        result: Value,
        #[serde(rename = "isError")]
        is_error: bool,
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
        #[serde(rename = "sourceEntryId", skip_serializing_if = "Option::is_none")]
        source_entry_id: Option<String>,
    },
    AssistantTurnEnd {
        #[serde(rename = "stopReason", skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
        #[serde(rename = "errorMessage", skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
        completion: TurnCompletion,
        #[serde(rename = "timestampMs", skip_serializing_if = "Option::is_none")]
        timestamp_ms: Option<i64>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnCompletion {
    Complete,
    Interrupted,
}

#[derive(Default)]
struct TurnMeta {
    has_assistant: bool,
    stop_reason: Option<String>,
    error_message: Option<String>,
    updated_at_ms: Option<i64>,
}

const SESSION_HISTORY_CACHE_CAPACITY: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SessionFileFingerprint {
    file_size: u64,
    file_mtime_ns: u64,
}

#[derive(Clone)]
struct CachedSessionHistory {
    fingerprint: SessionFileFingerprint,
    history: SessionHistory,
}

#[derive(Default)]
pub(crate) struct SessionHistoryCache {
    entries: HashMap<String, CachedSessionHistory>,
    order: VecDeque<String>,
}

impl SessionHistoryCache {
    fn get(&mut self, key: &str, fingerprint: SessionFileFingerprint) -> Option<SessionHistory> {
        let history = match self.entries.get(key) {
            Some(entry) if entry.fingerprint == fingerprint => entry.history.clone(),
            Some(_) => {
                self.remove(key);
                return None;
            }
            None => return None,
        };
        self.touch(key);
        Some(history)
    }

    fn insert(
        &mut self,
        key: String,
        fingerprint: SessionFileFingerprint,
        history: SessionHistory,
    ) {
        self.remove(&key);
        self.entries.insert(
            key.clone(),
            CachedSessionHistory {
                fingerprint,
                history,
            },
        );
        self.order.push_back(key);
        while self.order.len() > SESSION_HISTORY_CACHE_CAPACITY {
            if let Some(evicted) = self.order.pop_front() {
                self.entries.remove(&evicted);
            }
        }
    }

    fn touch(&mut self, key: &str) {
        self.order.retain(|candidate| candidate != key);
        self.order.push_back(key.to_owned());
    }

    fn remove(&mut self, key: &str) {
        self.entries.remove(key);
        self.order.retain(|candidate| candidate != key);
    }
}

fn cache_key(project: &Project, path: &str) -> String {
    format!("{}\0{path}", project.id)
}

fn fingerprint_from_metadata(metadata: &Value) -> Option<SessionFileFingerprint> {
    Some(SessionFileFingerprint {
        file_size: metadata.get("fileSize")?.as_u64()?,
        file_mtime_ns: metadata.get("fileMtimeNs")?.as_u64()?,
    })
}

async fn read_fingerprint(
    servers: &ServerManager,
    project: &Project,
    path: &str,
) -> Result<Option<SessionFileFingerprint>, String> {
    let (metadata, binary) = servers
        .request_with_binary(
            &project.connection,
            "session.read",
            serde_json::json!({ "path": path, "offset": 0, "limit": 1 }),
            Vec::new(),
        )
        .await?;
    if binary.len() != 1 {
        return Err(format!(
            "session.read expected one binary attachment, got {}",
            binary.len()
        ));
    }
    Ok(fingerprint_from_metadata(&metadata))
}

pub async fn read_history(
    servers: &ServerManager,
    cache: &tokio::sync::Mutex<SessionHistoryCache>,
    project: &Project,
    path: &str,
) -> Result<SessionHistory, String> {
    let key = cache_key(project, path);
    if let Some(fingerprint) = read_fingerprint(servers, project, path).await?
        && let Some(history) = cache.lock().await.get(&key, fingerprint)
    {
        return Ok(history);
    }

    let (bytes, fingerprint) = read_file(servers, project, path).await?;
    let history = parse_history(&bytes);
    if let Some(fingerprint) = fingerprint {
        cache.lock().await.insert(key, fingerprint, history.clone());
    }
    Ok(history)
}

async fn read_file(
    servers: &ServerManager,
    project: &Project,
    path: &str,
) -> Result<(Vec<u8>, Option<SessionFileFingerprint>), String> {
    const CHUNK_BYTES: usize = 8 * 1024 * 1024;
    let mut cursor = 0_u64;
    let mut data = Vec::new();
    let mut fingerprint = None;
    loop {
        let (metadata, binary) = servers
            .request_with_binary(
                &project.connection,
                "session.read",
                serde_json::json!({ "path": path, "offset": cursor, "limit": CHUNK_BYTES }),
                Vec::new(),
            )
            .await?;
        if binary.len() != 1 {
            return Err(format!(
                "session.read expected one binary attachment, got {}",
                binary.len()
            ));
        }
        if let Some(chunk_fingerprint) = fingerprint_from_metadata(&metadata) {
            match fingerprint {
                Some(existing) if existing != chunk_fingerprint => {
                    return Err("session changed while history was being read".to_owned());
                }
                None => fingerprint = Some(chunk_fingerprint),
                _ => {}
            }
        }
        let chunk = binary.into_iter().next().expect("binary length checked");
        let next_offset = metadata
            .get("nextOffset")
            .and_then(Value::as_u64)
            .ok_or_else(|| "pilo-server session chunk is missing nextOffset".to_owned())?;
        let eof = metadata
            .get("eof")
            .and_then(Value::as_bool)
            .ok_or_else(|| "pilo-server session chunk is missing eof".to_owned())?;
        if next_offset != cursor.saturating_add(chunk.len() as u64) {
            return Err("invalid pilo-server session chunk offset".to_owned());
        }
        data.extend_from_slice(&chunk);
        if eof {
            return Ok((data, fingerprint));
        }
        if chunk.is_empty() {
            return Err("pilo-server returned an empty non-terminal session chunk".to_owned());
        }
        cursor = next_offset;
    }
}

fn parse_history(bytes: &[u8]) -> SessionHistory {
    let entries = parse_entries(bytes);
    let branch = active_branch(&entries);
    project_branch(&branch)
}

fn parse_entries(bytes: &[u8]) -> Vec<Value> {
    bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .collect()
}

fn active_branch(entries: &[Value]) -> Vec<Value> {
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
        return entries.to_vec();
    };

    let mut indices = Vec::new();
    let mut seen = std::collections::HashSet::new();
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

    // Session headers and legacy global metadata may not carry ids. Preserve the header,
    // but all branch-sensitive entries come strictly from the selected parent chain.
    let mut result = Vec::new();
    if let Some(header) = entries.first()
        && header.get("type").and_then(Value::as_str) == Some("session")
        && header.get("id").is_none()
    {
        result.push(header.clone());
    }
    result.extend(indices.into_iter().map(|index| entries[index].clone()));
    result
}

fn project_branch(entries: &[Value]) -> SessionHistory {
    let mut history = SessionHistory::default();
    let mut turn = TurnMeta::default();

    for entry in entries {
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
            let content = content_array(message.get("content"));
            for (index, part) in content.iter().enumerate() {
                project_assistant_part(part, index, timestamp_ms, source_entry_id.clone(), events);
            }
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

fn content_array(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => vec![serde_json::json!({ "type": "text", "text": text })],
        Some(Value::Null) | None => Vec::new(),
        Some(value) => vec![value.clone()],
    }
}

fn user_text(value: Option<&Value>) -> String {
    content_array(value)
        .into_iter()
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
            fallback_text("User content", &part)
        })
        .collect::<Vec<_>>()
        .join("\n")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_cache_reuses_matching_fingerprint_and_invalidates_changes() {
        let mut cache = SessionHistoryCache::default();
        let first_fingerprint = SessionFileFingerprint {
            file_size: 100,
            file_mtime_ns: 200,
        };
        let changed_fingerprint = SessionFileFingerprint {
            file_size: 101,
            file_mtime_ns: 201,
        };
        let history = SessionHistory {
            source_message_count: 3,
            ..SessionHistory::default()
        };

        cache.insert(
            "project\0session".to_owned(),
            first_fingerprint,
            history.clone(),
        );
        assert_eq!(
            cache.get("project\0session", first_fingerprint),
            Some(history)
        );
        assert_eq!(cache.get("project\0session", changed_fingerprint), None);
        assert!(!cache.entries.contains_key("project\0session"));
    }

    #[test]
    fn history_cache_evicts_least_recently_used_entries() {
        let mut cache = SessionHistoryCache::default();
        let fingerprint = SessionFileFingerprint {
            file_size: 1,
            file_mtime_ns: 1,
        };
        for index in 0..SESSION_HISTORY_CACHE_CAPACITY {
            cache.insert(
                format!("session-{index}"),
                fingerprint,
                SessionHistory::default(),
            );
        }

        assert!(cache.get("session-0", fingerprint).is_some());
        cache.insert(
            "session-new".to_owned(),
            fingerprint,
            SessionHistory::default(),
        );

        assert!(cache.entries.contains_key("session-0"));
        assert!(!cache.entries.contains_key("session-1"));
        assert!(cache.entries.contains_key("session-new"));
    }

    #[test]
    fn session_read_fingerprint_is_optional_for_older_servers() {
        assert_eq!(
            fingerprint_from_metadata(&serde_json::json!({
                "fileSize": 123,
                "fileMtimeNs": 456,
            })),
            Some(SessionFileFingerprint {
                file_size: 123,
                file_mtime_ns: 456,
            })
        );
        assert_eq!(
            fingerprint_from_metadata(&serde_json::json!({
                "nextOffset": 1,
                "eof": false,
            })),
            None
        );
    }

    #[test]
    fn selects_only_the_active_session_branch() {
        let bytes = concat!(
            "{\"type\":\"session\",\"version\":3,\"id\":\"session-a\"}\n",
            "{\"type\":\"message\",\"id\":\"u1\",\"parentId\":null,\"timestamp\":\"2026-01-01T00:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
            "{\"type\":\"message\",\"id\":\"a-old\",\"parentId\":\"u1\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"old\"}],\"stopReason\":\"stop\"}}\n",
            "{\"type\":\"message\",\"id\":\"a-new\",\"parentId\":\"u1\",\"timestamp\":\"2026-01-01T00:00:02Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"new\"}],\"stopReason\":\"stop\"}}\n"
        ).as_bytes();
        let history = parse_history(bytes);
        let serialized = serde_json::to_string(&history.events).unwrap();
        assert!(serialized.contains("new"));
        assert!(!serialized.contains("old"));
        assert_eq!(history.source_message_count, 2);
    }

    #[test]
    fn branch_metadata_follows_selected_parent_chain() {
        let bytes = concat!(
            "{\"type\":\"session\",\"version\":3,\"id\":\"session-a\"}\n",
            "{\"type\":\"model_change\",\"id\":\"m1\",\"parentId\":null,\"provider\":\"p\",\"modelId\":\"base\"}\n",
            "{\"type\":\"model_change\",\"id\":\"m-old\",\"parentId\":\"m1\",\"provider\":\"p\",\"modelId\":\"old\"}\n",
            "{\"type\":\"model_change\",\"id\":\"m-new\",\"parentId\":\"m1\",\"provider\":\"p\",\"modelId\":\"new\"}\n"
        ).as_bytes();
        let history = parse_history(bytes);
        assert_eq!(history.model.unwrap().id, "new");
    }

    #[test]
    fn eof_after_tool_use_is_interrupted() {
        let bytes = concat!(
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"go\"}}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"t1\",\"name\":\"bash\",\"arguments\":{}}],\"stopReason\":\"toolUse\"}}\n"
        ).as_bytes();
        let history = parse_history(bytes);
        assert!(matches!(
            history.events.last(),
            Some(ConversationEventDto::AssistantTurnEnd {
                completion: TurnCompletion::Interrupted,
                ..
            })
        ));
    }
}
