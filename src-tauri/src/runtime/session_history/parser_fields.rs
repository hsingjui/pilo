use std::collections::HashMap;

use serde_json::{Map, Value};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::types::{HistoryImage, ImageLocation};

pub(super) fn record_image_locations(
    entry: &Value,
    line_offset: u64,
    line_length: u64,
    image_locations: &mut HashMap<String, ImageLocation>,
) {
    if entry.get("type").and_then(Value::as_str) != Some("message") {
        return;
    }
    let Some(message) = entry.get("message") else {
        return;
    };
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return;
    }
    let Some(parts) = message.get("content").and_then(Value::as_array) else {
        return;
    };
    // Entries without an id cannot be referenced from the projected events, so
    // their images would stay unfetchable; skip indexing them.
    let Some(base_id) = image_entry_base_id(entry) else {
        return;
    };
    for (index, part) in parts.iter().enumerate() {
        if part.get("type").and_then(Value::as_str) != Some("image") {
            continue;
        }
        image_locations.insert(
            history_image_id(&base_id, index),
            ImageLocation {
                byte_offset: line_offset,
                byte_length: line_length,
            },
        );
    }
}

fn image_entry_base_id(entry: &Value) -> Option<String> {
    entry
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

fn history_image_id(base_id: &str, content_index: usize) -> String {
    format!("{base_id}:{content_index}")
}
pub(super) fn entry_id(entry: &Value) -> Option<String> {
    entry.get("id").and_then(Value::as_str).map(str::to_owned)
}

pub(super) fn entry_timestamp_ms(entry: &Value, message: Option<&Value>) -> Option<i64> {
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

pub(super) fn user_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) != Some("image"))
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
                fallback_text("User content", part)
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::Null) | None => String::new(),
        Some(value) => fallback_text("User content", value),
    }
}

pub(super) fn user_images(value: Option<&Value>, base_id: Option<&str>) -> Vec<HistoryImage> {
    let Some(base_id) = base_id else {
        return Vec::new();
    };
    let Some(parts) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    parts
        .iter()
        .enumerate()
        .filter(|(_, part)| part.get("type").and_then(Value::as_str) == Some("image"))
        .map(|(index, part)| HistoryImage {
            id: history_image_id(base_id, index),
            mime_type: part
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("image/png")
                .to_owned(),
        })
        .collect()
}

pub(super) fn tool_result_payload(message: &Value) -> Value {
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

pub(super) fn fallback_text(label: &str, value: &Value) -> String {
    let mut serialized = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
    const MAX_FALLBACK_BYTES: usize = 16 * 1024;
    if serialized.len() > MAX_FALLBACK_BYTES {
        serialized.truncate(MAX_FALLBACK_BYTES);
        serialized.push_str("\n… truncated …");
    }
    format!("{label}\n\n```json\n{serialized}\n```")
}

pub(super) fn normalize_thinking(value: &str) -> String {
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
