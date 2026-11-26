use std::{ops::Range, sync::Arc};

use serde::Serialize;

use super::{
    cache::{SessionFileFingerprint, SessionHistoryWindowIndex},
    types::{ConversationEventDto, SessionHistory},
};

const EVENTS_PREFIX: &[u8] = b"{\"events\":[";

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

fn json_serialized_len(value: &serde_json::Value) -> usize {
    let mut size = crate::events::PayloadSize::default();
    if serde_json::to_writer(&mut size, value).is_ok() {
        size.0
    } else {
        0
    }
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
                    String::new()
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
                        "[image]".to_owned()
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
                    .saturating_add(json_serialized_len(args));
                if preview.is_empty() {
                    preview = format!("{} …", tool_name);
                }
            }
            ConversationEventDto::ToolExecutionEnd { result, .. } => {
                estimated_chars = estimated_chars.saturating_add(json_serialized_len(result));
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

pub(super) fn serialize_windowed_history(
    history: SessionHistory,
) -> Result<(Arc<Vec<u8>>, Arc<SessionHistoryWindowIndex>), String> {
    let mut serialized = EVENTS_PREFIX.to_vec();
    let index = serialize_history_tail(history, &HistoryPrefix::EMPTY, &mut serialized, 0)?;
    Ok((Arc::new(serialized), Arc::new(index)))
}

/// Serialized messages kept from a cached projection. Both byte prefixes end
/// right before the first replaced message, including its leading separator.
pub(super) struct HistoryPrefix<'a> {
    pub(super) serialized_len: usize,
    pub(super) events_content_start: usize,
    pub(super) message_ranges: &'a [Range<usize>],
    pub(super) directory: &'a [u8],
    pub(super) directory_ranges: &'a [Range<usize>],
}

impl HistoryPrefix<'_> {
    const EMPTY: HistoryPrefix<'static> = HistoryPrefix {
        serialized_len: EVENTS_PREFIX.len(),
        events_content_start: EVENTS_PREFIX.len(),
        message_ranges: &[],
        directory: b"[",
        directory_ranges: &[],
    };
}

/// Appends `history` after `prefix`. `output` starts at serialized offset
/// `output_offset`: it already holds the prefix when that is 0, or receives only
/// the tail when the prefix lives elsewhere (a disk cache).
pub(super) fn serialize_history_tail(
    history: SessionHistory,
    prefix: &HistoryPrefix<'_>,
    output: &mut Vec<u8>,
    output_offset: usize,
) -> Result<SessionHistoryWindowIndex, String> {
    let SessionHistory {
        events,
        model,
        thinking_level,
        name,
        header_missing,
        source_message_count,
        stats,
        image_locations,
        first_message_index,
        mut incremental,
    } = history;
    if first_message_index != prefix.message_ranges.len()
        || output_offset + output.len() != prefix.serialized_len
    {
        return Err("history tail does not continue its cached prefix".to_owned());
    }
    let messages = split_history_messages(events);
    // A kept prefix ends with the separator before its first replaced message.
    if first_message_index > 0 && messages.is_empty() {
        return Err("history tail has no message after its cached prefix".to_owned());
    }
    if let Some(state) = incremental.as_mut() {
        let entry_id = Some(state.checkpoint.entry_id.as_str());
        let checkpoint = messages.iter().rposition(|events| match events.first() {
            Some(
                ConversationEventDto::UserMessageStart {
                    source_entry_id, ..
                }
                | ConversationEventDto::CompactionMarker {
                    source_entry_id, ..
                },
            ) => source_entry_id.as_deref() == entry_id,
            _ => false,
        });
        match checkpoint {
            Some(position) => state.checkpoint.message_index = first_message_index + position,
            None => incremental = None,
        }
    }

    // Same bytes as serializing the whole directory array, with per-entry ranges.
    let mut directory = prefix.directory.to_vec();
    let mut directory_ranges = prefix.directory_ranges.to_vec();
    directory_ranges.reserve(messages.len());
    for (position, events) in messages.iter().enumerate() {
        if position > 0 {
            directory.push(b',');
        }
        let start = directory.len();
        serde_json::to_writer(
            &mut directory,
            &describe_history_message(first_message_index + position, events),
        )
        .map_err(|error| format!("failed to serialize history message index: {error}"))?;
        directory_ranges.push(start..directory.len());
    }
    directory.push(b']');

    let mut message_ranges = prefix.message_ranges.to_vec();
    message_ranges.reserve(messages.len());
    for (position, message_events) in messages.iter().enumerate() {
        if position > 0 {
            output.push(b',');
        }
        let start = output_offset + output.len();
        for (event_index, event) in message_events.iter().enumerate() {
            if event_index > 0 {
                output.push(b',');
            }
            serde_json::to_writer(&mut *output, event)
                .map_err(|error| format!("failed to serialize history events: {error}"))?;
        }
        message_ranges.push(start..output_offset + output.len());
    }
    let events_content_end = output_offset + output.len();
    output.extend_from_slice(b"],\"model\":");
    push_json_value(output, &model)?;
    output.extend_from_slice(b",\"thinkingLevel\":");
    push_json_value(output, &thinking_level)?;
    output.extend_from_slice(b",\"name\":");
    push_json_value(output, &name)?;
    output.extend_from_slice(b",\"headerMissing\":");
    push_json_value(output, &header_missing)?;
    output.extend_from_slice(b",\"sourceMessageCount\":");
    push_json_value(output, &source_message_count)?;
    output.extend_from_slice(b",\"stats\":");
    push_json_value(output, &stats)?;
    output.push(b'}');

    Ok(SessionHistoryWindowIndex {
        events_content_start: prefix.events_content_start,
        events_content_end,
        message_ranges,
        message_index_json: Arc::new(directory),
        directory_ranges,
        image_locations: Arc::new(image_locations),
        incremental,
    })
}

pub(super) fn serialize_history_window_response(
    serialized_history: &[u8],
    index: &SessionHistoryWindowIndex,
    start_message: Option<usize>,
    message_limit: usize,
    include_message_index: bool,
    fingerprint: Option<SessionFileFingerprint>,
) -> Vec<u8> {
    let window = history_window_range(index.message_ranges.len(), start_message, message_limit);
    let events = match (
        index.message_ranges.get(window.start),
        window
            .end
            .checked_sub(1)
            .and_then(|end| index.message_ranges.get(end)),
    ) {
        (Some(first), Some(last)) if !window.is_empty() => {
            &serialized_history[first.start..last.end]
        }
        _ => &[],
    };
    serialize_history_window_parts(
        &serialized_history[..index.events_content_start],
        events,
        &serialized_history[index.events_content_end..serialized_history.len() - 1],
        index,
        window,
        include_message_index,
        fingerprint,
    )
}

pub(super) fn history_window_range(
    total_messages: usize,
    start_message: Option<usize>,
    message_limit: usize,
) -> std::ops::Range<usize> {
    let limit = message_limit.clamp(1, 256);
    let start = start_message
        .unwrap_or_else(|| total_messages.saturating_sub(limit))
        .min(total_messages);
    start..start.saturating_add(limit).min(total_messages)
}

pub(super) fn serialize_history_window_parts(
    prefix: &[u8],
    events: &[u8],
    suffix: &[u8],
    index: &SessionHistoryWindowIndex,
    window: std::ops::Range<usize>,
    include_message_index: bool,
    fingerprint: Option<SessionFileFingerprint>,
) -> Vec<u8> {
    let message_index_len = if include_message_index {
        index.message_index_json.len().saturating_add(16)
    } else {
        0
    };
    let fingerprint_json = fingerprint
        .map(|fingerprint| {
            format!(
                "{{\"fileSize\":{},\"fileMtimeNs\":\"{}\"}}",
                fingerprint.file_size, fingerprint.file_mtime_ns
            )
        })
        .unwrap_or_else(|| "null".to_owned());
    let mut response = Vec::with_capacity(
        prefix
            .len()
            .saturating_add(events.len())
            .saturating_add(suffix.len())
            .saturating_add(message_index_len)
            .saturating_add(fingerprint_json.len())
            .saturating_add(160),
    );
    response.extend_from_slice(b"{\"history\":");
    response.extend_from_slice(prefix);
    response.extend_from_slice(events);
    response.extend_from_slice(suffix);
    response.extend_from_slice(
        format!(
            ",\"windowStartMessage\":{},\"windowMessageCount\":{},\"totalMessages\":{}",
            window.start,
            window.len(),
            index.message_ranges.len()
        )
        .as_bytes(),
    );
    if include_message_index {
        response.extend_from_slice(b",\"messageIndex\":");
        response.extend_from_slice(index.message_index_json.as_ref());
    }
    response.extend_from_slice(b"},\"fingerprint\":");
    response.extend_from_slice(fingerprint_json.as_bytes());
    response.push(b'}');
    response
}

pub(super) fn serialize_history_response(
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

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::super::parser::HistoryParser;
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
