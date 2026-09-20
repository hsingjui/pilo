use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use serde::Serialize;
use serde_json::Value;

use crate::domain::Project;
use crate::runtime::server_client::ServerManager;

use super::{
    cache::{
        SessionFileFingerprint, SessionHistoryCache, SessionHistoryWindowIndex, cache_key,
        fingerprint_from_metadata,
    },
    parser::HistoryParser,
    types::{ConversationEventDto, SessionHistory},
};

const HISTORY_CHANGED_DURING_READ: &str = "session changed while history was being read";
const HISTORY_CHANGED_READ_RETRIES: usize = 2;
const SESSION_RANGE_CHUNK_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryMessageIndexEntry {
    id: String,
    role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp_ms: Option<i64>,
    preview: String,
    estimated_chars: usize,
}

fn push_json_value<T: Serialize>(output: &mut Vec<u8>, value: &T) -> Result<(), String> {
    serde_json::to_writer(output, value)
        .map_err(|error| format!("failed to serialize session history: {error}"))
}

fn split_history_messages(events: Vec<ConversationEventDto>) -> Vec<Vec<ConversationEventDto>> {
    let mut messages = Vec::new();
    let mut current = Vec::new();

    for event in events {
        match &event {
            ConversationEventDto::CompactionMarker { .. } => {
                if !current.is_empty() {
                    messages.push(std::mem::take(&mut current));
                }
                messages.push(vec![event]);
            }
            ConversationEventDto::UserMessageStart { .. } => {
                if !current.is_empty() {
                    messages.push(std::mem::take(&mut current));
                }
                messages.push(vec![event]);
            }
            ConversationEventDto::AssistantMessageStart { .. } => {
                if !current.is_empty() {
                    messages.push(std::mem::take(&mut current));
                }
                current.push(event);
            }
            ConversationEventDto::AssistantTurnEnd { .. } => {
                current.push(event);
                messages.push(std::mem::take(&mut current));
            }
            _ => current.push(event),
        }
    }
    if !current.is_empty() {
        messages.push(current);
    }
    messages
}

fn preview_text(value: &str) -> String {
    const MAX_PREVIEW_CHARS: usize = 240;
    let mut chars = value.chars();
    let preview = chars.by_ref().take(MAX_PREVIEW_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{}…", preview.trim_end())
    } else {
        preview
    }
}

/// Skill 调用被 Pi 展开成 `<skill name="…">…</skill>` 大段文本，
/// 历史占位摘要改用 `/skill:<name> 补充指令` 的紧凑形式。
fn skill_invocation_summary(text: &str) -> Option<String> {
    let rest = text.strip_prefix("<skill name=\"")?;
    let name_end = rest.find('"')?;
    let name = &rest[..name_end];
    if name.is_empty() {
        return None;
    }
    let closing = text.find("</skill>")?;
    let instructions = text[closing + "</skill>".len()..]
        .trim_start_matches('\n')
        .trim();
    Some(if instructions.is_empty() {
        format!("/skill:{name}")
    } else {
        format!("/skill:{name} {instructions}")
    })
}

fn user_message_preview(text: &str) -> String {
    skill_invocation_summary(text)
        .map_or_else(|| preview_text(text), |summary| preview_text(&summary))
}

fn describe_history_message(
    index: usize,
    events: &[ConversationEventDto],
) -> HistoryMessageIndexEntry {
    let mut role = "assistant";
    let mut source_id = None;
    let mut timestamp_ms = None;
    let mut preview = String::new();
    let mut estimated_chars = 0_usize;

    for event in events {
        match event {
            ConversationEventDto::CompactionMarker {
                summary,
                timestamp_ms: timestamp,
                source_entry_id,
                ..
            } => {
                role = "compaction";
                source_id = source_id.clone().or_else(|| source_entry_id.clone());
                timestamp_ms = timestamp_ms.or(*timestamp);
                estimated_chars = estimated_chars.saturating_add(summary.chars().count());
                preview = if summary.is_empty() {
                    "上下文已压缩".to_owned()
                } else {
                    preview_text(summary)
                };
            }
            ConversationEventDto::UserMessageStart {
                text,
                images,
                timestamp_ms: timestamp,
                source_entry_id,
            } => {
                role = "user";
                source_id = source_id.clone().or_else(|| source_entry_id.clone());
                timestamp_ms = timestamp_ms.or(*timestamp);
                estimated_chars = estimated_chars.saturating_add(text.chars().count());
                if preview.is_empty() {
                    preview = if text.is_empty() && !images.is_empty() {
                        "[图片]".to_owned()
                    } else {
                        user_message_preview(text)
                    };
                }
            }
            ConversationEventDto::AssistantMessageStart {
                timestamp_ms: timestamp,
                source_entry_id,
            } => {
                source_id = source_id.clone().or_else(|| source_entry_id.clone());
                timestamp_ms = timestamp_ms.or(*timestamp);
            }
            ConversationEventDto::AssistantTextDelta { delta, .. } => {
                estimated_chars = estimated_chars.saturating_add(delta.chars().count());
                if preview.chars().count() < 240 {
                    let remaining = 240_usize.saturating_sub(preview.chars().count());
                    preview.extend(delta.chars().take(remaining));
                }
            }
            ConversationEventDto::AssistantThinkingDelta { delta, .. } => {
                estimated_chars = estimated_chars.saturating_add(delta.chars().count());
            }
            ConversationEventDto::ToolExecutionStart {
                tool_name, args, ..
            } => {
                estimated_chars = estimated_chars
                    .saturating_add(tool_name.len())
                    .saturating_add(args.to_string().len());
                if preview.is_empty() {
                    preview = format!("{} …", tool_name);
                }
            }
            ConversationEventDto::ToolExecutionEnd { result, .. } => {
                estimated_chars = estimated_chars.saturating_add(result.to_string().len());
            }
            ConversationEventDto::AssistantThinkingStart { .. }
            | ConversationEventDto::AssistantThinkingEnd { .. }
            | ConversationEventDto::AssistantTurnEnd { .. } => {}
        }
    }

    HistoryMessageIndexEntry {
        id: source_id.unwrap_or_else(|| format!("history-{role}-{index}")),
        role,
        timestamp_ms,
        preview: preview_text(&preview),
        estimated_chars,
    }
}

fn serialize_windowed_history(
    history: SessionHistory,
) -> Result<(Arc<Vec<u8>>, Arc<SessionHistoryWindowIndex>), String> {
    let SessionHistory {
        events,
        model,
        thinking_level,
        name,
        source_message_count,
        stats,
        image_locations,
    } = history;
    let messages = split_history_messages(events);
    let directory = messages
        .iter()
        .enumerate()
        .map(|(index, events)| describe_history_message(index, events))
        .collect::<Vec<_>>();
    let message_index_json = Arc::new(
        serde_json::to_vec(&directory)
            .map_err(|error| format!("failed to serialize history message index: {error}"))?,
    );

    let mut serialized = Vec::new();
    serialized.extend_from_slice(b"{\"events\":[");
    let events_content_start = serialized.len();
    let mut message_ranges = Vec::with_capacity(messages.len());
    let mut first = true;
    for message_events in &messages {
        let event_json = serde_json::to_vec(message_events)
            .map_err(|error| format!("failed to serialize history events: {error}"))?;
        if !first {
            serialized.push(b',');
        }
        first = false;
        let start = serialized.len();
        if event_json.len() >= 2 {
            serialized.extend_from_slice(&event_json[1..event_json.len() - 1]);
        }
        let end = serialized.len();
        message_ranges.push(start..end);
    }
    let events_content_end = serialized.len();
    serialized.extend_from_slice(b"],\"model\":");
    push_json_value(&mut serialized, &model)?;
    serialized.extend_from_slice(b",\"thinkingLevel\":");
    push_json_value(&mut serialized, &thinking_level)?;
    serialized.extend_from_slice(b",\"name\":");
    push_json_value(&mut serialized, &name)?;
    serialized.extend_from_slice(b",\"sourceMessageCount\":");
    push_json_value(&mut serialized, &source_message_count)?;
    serialized.extend_from_slice(b",\"stats\":");
    push_json_value(&mut serialized, &stats)?;
    serialized.push(b'}');

    Ok((
        Arc::new(serialized),
        Arc::new(SessionHistoryWindowIndex {
            events_content_start,
            events_content_end,
            message_ranges,
            message_index_json,
            image_locations: Arc::new(image_locations),
        }),
    ))
}

fn serialize_history_window_response(
    serialized_history: &[u8],
    index: &SessionHistoryWindowIndex,
    start_message: Option<usize>,
    message_limit: usize,
    include_message_index: bool,
    fingerprint: Option<SessionFileFingerprint>,
) -> Vec<u8> {
    let total_messages = index.message_ranges.len();
    let message_limit = message_limit.clamp(1, 256);
    let start_message = start_message
        .unwrap_or_else(|| total_messages.saturating_sub(message_limit))
        .min(total_messages);
    let end_message = start_message
        .saturating_add(message_limit)
        .min(total_messages);

    let mut history = Vec::with_capacity(serialized_history.len().min(512 * 1024));
    history.extend_from_slice(&serialized_history[..index.events_content_start]);
    for (offset, range) in index.message_ranges[start_message..end_message]
        .iter()
        .enumerate()
    {
        if offset > 0 {
            history.push(b',');
        }
        history.extend_from_slice(&serialized_history[range.clone()]);
    }
    history.extend_from_slice(
        &serialized_history[index.events_content_end..serialized_history.len() - 1],
    );
    history.extend_from_slice(
        format!(
            ",\"windowStartMessage\":{start_message},\"windowMessageCount\":{},\"totalMessages\":{total_messages}",
            end_message.saturating_sub(start_message)
        )
        .as_bytes(),
    );
    if include_message_index {
        history.extend_from_slice(b",\"messageIndex\":");
        history.extend_from_slice(index.message_index_json.as_ref());
    }
    history.push(b'}');
    serialize_history_response(&history, fingerprint)
}

fn serialize_history_response(
    serialized_history: &[u8],
    fingerprint: Option<SessionFileFingerprint>,
) -> Vec<u8> {
    let fingerprint_json = fingerprint
        .map(|fingerprint| {
            format!(
                "{{\"fileSize\":{},\"fileMtimeNs\":\"{}\"}}",
                fingerprint.file_size, fingerprint.file_mtime_ns
            )
        })
        .unwrap_or_else(|| "null".to_owned());
    let mut response = Vec::with_capacity(serialized_history.len() + fingerprint_json.len() + 40);
    response.extend_from_slice(b"{\"history\":");
    response.extend_from_slice(serialized_history);
    response.extend_from_slice(b",\"fingerprint\":");
    response.extend_from_slice(fingerprint_json.as_bytes());
    response.push(b'}');
    response
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
            serde_json::json!({ "path": path, "offset": 0, "limit": 0 }),
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

/// Lazily loads one user-image payload from the session JSONL. The image id is
/// `{entryId}:{contentIndex}` as emitted on `UserMessageStart.images`.
pub async fn read_history_image_bytes(
    servers: &ServerManager,
    cache: &tokio::sync::Mutex<SessionHistoryCache>,
    project: &Project,
    path: &str,
    image_id: &str,
    expected_fingerprint: Option<(u64, u64)>,
) -> Result<Vec<u8>, String> {
    let key = cache_key(project, path);
    let fingerprint = match expected_fingerprint {
        Some((file_size, file_mtime_ns)) => SessionFileFingerprint {
            file_size,
            file_mtime_ns,
        },
        None => read_fingerprint(servers, project, path)
            .await?
            .ok_or_else(|| "session file metadata is unavailable".to_owned())?,
    };

    let locations = if let Some((_, index)) = cache.lock().await.get_windowed(&key, fingerprint) {
        Arc::clone(&index.image_locations)
    } else if let Some(locations) = cache.lock().await.get_image_locations(&key, fingerprint) {
        locations
    } else {
        let (history, parsed_fingerprint) = read_file(servers, project, path).await?;
        let locations = Arc::new(history.image_locations);
        if let Some(parsed_fingerprint) = parsed_fingerprint {
            cache.lock().await.insert_image_locations(
                key,
                parsed_fingerprint,
                Arc::clone(&locations),
            );
        }
        locations
    };

    let location = locations
        .get(image_id)
        .ok_or_else(|| format!("session history image '{image_id}' was not found"))?;
    let line = read_session_range(
        servers,
        project,
        path,
        location.byte_offset,
        location.byte_length,
    )
    .await?;
    extract_history_image_bytes(&line, image_id)
}

async fn read_session_range(
    servers: &ServerManager,
    project: &Project,
    path: &str,
    offset: u64,
    length: u64,
) -> Result<Vec<u8>, String> {
    // The line length comes from the parsed file index, but clamp the initial
    // allocation anyway so a corrupt index cannot request a huge buffer up front.
    let mut out = Vec::with_capacity(
        usize::try_from(length)
            .unwrap_or(0)
            .min(SESSION_RANGE_CHUNK_BYTES),
    );
    let mut cursor = offset;
    let end = offset.saturating_add(length);
    while cursor < end {
        let chunk_limit = SESSION_RANGE_CHUNK_BYTES.min((end - cursor) as usize);
        let (metadata, binary) = servers
            .request_with_binary(
                &project.connection,
                "session.read",
                serde_json::json!({ "path": path, "offset": cursor, "limit": chunk_limit }),
                Vec::new(),
            )
            .await?;
        if binary.len() != 1 {
            return Err(format!(
                "session.read expected one binary attachment, got {}",
                binary.len()
            ));
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
        if chunk.is_empty() {
            return Err("pilo-server returned an empty non-terminal session chunk".to_owned());
        }
        out.extend_from_slice(&chunk);
        if next_offset != cursor.saturating_add(chunk.len() as u64) {
            return Err("invalid pilo-server session chunk offset".to_owned());
        }
        cursor = next_offset;
        if eof && cursor < end {
            return Err("session file ended before the image range was fully read".to_owned());
        }
    }
    Ok(out)
}

fn extract_history_image_bytes(line: &[u8], image_id: &str) -> Result<Vec<u8>, String> {
    let (base_id, content_index) = image_id
        .rsplit_once(':')
        .ok_or_else(|| format!("invalid session history image id '{image_id}'"))?;
    let content_index: usize = content_index
        .parse()
        .map_err(|_| format!("invalid session history image id '{image_id}'"))?;
    let entry: Value = serde_json::from_slice(line)
        .map_err(|error| format!("failed to parse session history image line: {error}"))?;
    if entry.get("id").and_then(Value::as_str) != Some(base_id) {
        return Err(format!(
            "session history image '{image_id}' points at an unrelated entry"
        ));
    }
    let part = entry
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .and_then(|parts| parts.get(content_index))
        .ok_or_else(|| format!("session history image '{image_id}' content is missing"))?;
    if part.get("type").and_then(Value::as_str) != Some("image") {
        return Err(format!(
            "session history image '{image_id}' content is not an image"
        ));
    }
    let data = part
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("session history image '{image_id}' payload is missing"))?;
    STANDARD
        .decode(data)
        .or_else(|_| STANDARD_NO_PAD.decode(data))
        .map_err(|error| format!("failed to decode session history image '{image_id}': {error}"))
}

pub async fn read_history_json(
    servers: &ServerManager,
    cache: &tokio::sync::Mutex<SessionHistoryCache>,
    project: &Project,
    path: &str,
    expected_fingerprint: Option<(u64, u64)>,
) -> Result<Vec<u8>, String> {
    let key = cache_key(project, path);
    if let Some((file_size, file_mtime_ns)) = expected_fingerprint {
        let fingerprint = SessionFileFingerprint {
            file_size,
            file_mtime_ns,
        };
        if let Some(serialized) = cache.lock().await.get_serialized(&key, fingerprint) {
            return Ok(serialize_history_response(
                serialized.as_ref(),
                Some(fingerprint),
            ));
        }
    } else if let Some(fingerprint) = read_fingerprint(servers, project, path).await?
        && let Some(serialized) = cache.lock().await.get_serialized(&key, fingerprint)
    {
        return Ok(serialize_history_response(
            serialized.as_ref(),
            Some(fingerprint),
        ));
    }

    let (history, fingerprint) = read_file(servers, project, path).await?;
    let (serialized, window_index) = serialize_windowed_history(history)?;
    if let Some(fingerprint) = fingerprint {
        cache
            .lock()
            .await
            .insert_windowed(key, fingerprint, Arc::clone(&serialized), window_index);
    }
    Ok(serialize_history_response(serialized.as_ref(), fingerprint))
}

// Thin pass-through from Tauri commands: splitting the arguments would only move them around.
#[allow(clippy::too_many_arguments)]
pub async fn read_history_window_json(
    servers: &ServerManager,
    cache: &tokio::sync::Mutex<SessionHistoryCache>,
    project: &Project,
    path: &str,
    expected_fingerprint: Option<(u64, u64)>,
    start_message: Option<usize>,
    message_limit: usize,
    include_message_index: bool,
) -> Result<Vec<u8>, String> {
    let key = cache_key(project, path);
    let cached_fingerprint = if let Some((file_size, file_mtime_ns)) = expected_fingerprint {
        Some(SessionFileFingerprint {
            file_size,
            file_mtime_ns,
        })
    } else {
        read_fingerprint(servers, project, path).await?
    };

    if let Some(fingerprint) = cached_fingerprint
        && let Some((serialized, index)) = cache.lock().await.get_windowed(&key, fingerprint)
    {
        return Ok(serialize_history_window_response(
            serialized.as_ref(),
            index.as_ref(),
            start_message,
            message_limit,
            include_message_index,
            Some(fingerprint),
        ));
    }

    let (history, fingerprint) = read_file(servers, project, path).await?;
    let (serialized, index) = serialize_windowed_history(history)?;
    if let Some(fingerprint) = fingerprint {
        cache.lock().await.insert_windowed(
            key,
            fingerprint,
            Arc::clone(&serialized),
            Arc::clone(&index),
        );
    }
    Ok(serialize_history_window_response(
        serialized.as_ref(),
        index.as_ref(),
        start_message,
        message_limit,
        include_message_index,
        fingerprint,
    ))
}

async fn read_file(
    servers: &ServerManager,
    project: &Project,
    path: &str,
) -> Result<(SessionHistory, Option<SessionFileFingerprint>), String> {
    for attempt in 0..=HISTORY_CHANGED_READ_RETRIES {
        match read_file_once(servers, project, path).await {
            Err(error)
                if error == HISTORY_CHANGED_DURING_READ
                    && attempt < HISTORY_CHANGED_READ_RETRIES =>
            {
                tokio::task::yield_now().await;
            }
            result => return result,
        }
    }
    unreachable!("history retry loop always returns")
}

async fn read_file_once(
    servers: &ServerManager,
    project: &Project,
    path: &str,
) -> Result<(SessionHistory, Option<SessionFileFingerprint>), String> {
    const CHUNK_BYTES: usize = 16 * 1024 * 1024;
    let mut cursor = 0_u64;
    let mut parser = HistoryParser::default();
    let mut fingerprint = None;
    let mut snapshot_size = None;
    loop {
        let remaining = snapshot_size
            .map(|size: u64| size.saturating_sub(cursor) as usize)
            .unwrap_or(CHUNK_BYTES);
        if snapshot_size.is_some() && remaining == 0 {
            return Ok((parser.finish(), fingerprint));
        }
        let (metadata, binary) = servers
            .request_with_binary(
                &project.connection,
                "session.read",
                serde_json::json!({ "path": path, "offset": cursor, "limit": CHUNK_BYTES.min(remaining) }),
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
                Some(existing) => {
                    let target_size = snapshot_size.unwrap_or(existing.file_size);
                    if chunk_fingerprint.file_size < target_size
                        || (chunk_fingerprint.file_size == target_size
                            && chunk_fingerprint.file_mtime_ns != existing.file_mtime_ns)
                    {
                        return Err(HISTORY_CHANGED_DURING_READ.to_owned());
                    }
                }
                None => {
                    snapshot_size = Some(chunk_fingerprint.file_size);
                    fingerprint = Some(chunk_fingerprint);
                }
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
        parser.push(&chunk);
        if snapshot_size.is_some_and(|size| next_offset >= size) || eof {
            return Ok((parser.finish(), fingerprint));
        }
        if chunk.is_empty() {
            return Err("pilo-server returned an empty non-terminal session chunk".to_owned());
        }
        cursor = next_offset;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_invocation_preview_uses_compact_summary() {
        let text = concat!(
            "<skill name=\"animate\" location=\"/root/.agents/skills/animate/SKILL.md\">\n",
            "References are relative to /root/.agents/skills/animate.\n\n",
            "Make it move.\n</skill>\n\n",
            "给按钮加个过渡"
        );
        assert_eq!(user_message_preview(text), "/skill:animate 给按钮加个过渡");
    }

    #[test]
    fn skill_invocation_preview_without_instructions_keeps_command_only() {
        let text = "<skill name=\"animate\" location=\"/x/SKILL.md\">\nbody\n</skill>";
        assert_eq!(user_message_preview(text), "/skill:animate");
    }

    #[test]
    fn incomplete_skill_block_falls_back_to_plain_preview() {
        let text = "<skill name=\"animate\">仍在流式写入的半个块";
        assert_eq!(user_message_preview(text), text);
    }

    #[test]
    fn plain_user_message_keeps_default_preview() {
        assert_eq!(user_message_preview("普通消息"), "普通消息");
    }

    #[test]
    fn history_image_bytes_are_decoded_from_the_target_content_part() {
        let line = r#"{"type":"message","id":"u2","message":{"role":"user","content":[{"type":"text","text":"看"},{"type":"image","data":"aGk=","mimeType":"image/png"}]}}"#;
        let bytes = extract_history_image_bytes(line.as_bytes(), "u2:1").unwrap();
        assert_eq!(bytes, b"hi");
    }

    #[test]
    fn history_image_bytes_reject_unknown_ids_and_non_image_parts() {
        let line = br#"{"type":"message","id":"u2","message":{"role":"user","content":[{"type":"image","data":"aGk=","mimeType":"image/png"}]}}"#;
        assert!(extract_history_image_bytes(line, "u2").is_err());
        assert!(extract_history_image_bytes(line, "u2:1").is_err());
        assert!(extract_history_image_bytes(line, "other:0").is_err());
    }

    #[test]
    fn history_response_includes_the_actual_file_fingerprint() {
        let response = serialize_history_response(
            br#"{"events":[],"model":null,"thinkingLevel":null,"name":null,"sourceMessageCount":0}"#,
            Some(SessionFileFingerprint {
                file_size: 123,
                file_mtime_ns: u64::MAX,
            }),
        );
        let value: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(value["history"]["events"], serde_json::json!([]));
        assert_eq!(value["fingerprint"]["fileSize"], 123);
        assert_eq!(value["fingerprint"]["fileMtimeNs"], u64::MAX.to_string());
    }

    #[test]
    fn history_window_serializes_only_requested_messages_and_keeps_directory() {
        let bytes = concat!(
            "{\"type\":\"message\",\"id\":\"u1\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"first user\"}}\n",
            "{\"type\":\"message\",\"id\":\"a1\",\"parentId\":\"u1\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}],\"stopReason\":\"stop\"}}\n",
            "{\"type\":\"message\",\"id\":\"u2\",\"parentId\":\"a1\",\"message\":{\"role\":\"user\",\"content\":\"second user\"}}\n",
            "{\"type\":\"message\",\"id\":\"a2\",\"parentId\":\"u2\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"second answer\"}],\"stopReason\":\"stop\"}}\n"
        )
        .as_bytes();
        let mut parser = HistoryParser::default();
        parser.push(bytes);
        let (serialized, index) = serialize_windowed_history(parser.finish()).unwrap();
        let response = serialize_history_window_response(
            serialized.as_ref(),
            index.as_ref(),
            Some(2),
            2,
            true,
            None,
        );
        let value: Value = serde_json::from_slice(&response).unwrap();
        let history = &value["history"];
        assert_eq!(history["windowStartMessage"], 2);
        assert_eq!(history["windowMessageCount"], 2);
        assert_eq!(history["totalMessages"], 4);
        assert_eq!(history["messageIndex"].as_array().unwrap().len(), 4);
        let events = serde_json::to_string(&history["events"]).unwrap();
        assert!(events.contains("second user"));
        assert!(events.contains("second answer"));
        assert!(!events.contains("first user"));
        assert!(!events.contains("first answer"));
    }
}
