use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
    time::UNIX_EPOCH,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{agent_dir, session_dir_key};

const DEFAULT_SEARCH_LIMIT: usize = 24;
const MAX_SEARCH_LIMIT: usize = 80;
const MAX_SNIPPET_CHARS: usize = 220;
const MAX_SEARCHABLE_MESSAGE_CHARS: usize = 200_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionSearchParams {
    project: String,
    query: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSearchMatch {
    session_path: String,
    session_id: String,
    role: String,
    snippet: String,
    timestamp: Option<Value>,
}

pub(crate) fn session_search(params: SessionSearchParams) -> Result<Value, String> {
    let query = params.query.trim();
    if query.is_empty() {
        return Ok(json!([]));
    }
    let limit = params
        .limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT);
    let Some(root) = agent_dir().map(|root| {
        root.join("sessions")
            .join(session_dir_key(params.project.trim()))
    }) else {
        return Ok(json!([]));
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(json!([]));
    };

    let mut files = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                return None;
            }
            let modified_ns = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_nanos())
                .unwrap_or_default();
            Some((modified_ns, path))
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));

    let query_folded = query.to_lowercase();
    let mut matches = Vec::with_capacity(limit.min(16));
    for (_, path) in files {
        search_file(&path, &query_folded, limit, &mut matches)?;
        if matches.len() >= limit {
            break;
        }
    }
    serde_json::to_value(matches).map_err(|error| error.to_string())
}

#[derive(Deserialize)]
struct RawSessionLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    id: Option<String>,
    timestamp: Option<Value>,
    message: Option<RawMessage>,
}

#[derive(Deserialize)]
struct RawMessage {
    role: Option<String>,
    content: Option<RawContent>,
    timestamp: Option<Value>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawContent {
    Text(String),
    Parts(Vec<RawPart>),
    Other(serde::de::IgnoredAny),
}

#[derive(Deserialize)]
struct RawPart {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
}

fn search_file(
    path: &Path,
    query_folded: &str,
    limit: usize,
    matches: &mut Vec<SessionSearchMatch>,
) -> Result<(), String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Ok(()),
    };
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut session_id = None;
    let mut line_buf = Vec::with_capacity(4096);
    let session_finder = memchr::memmem::Finder::new(b"\"session\"");
    let message_finder = memchr::memmem::Finder::new(b"\"message\"");
    loop {
        line_buf.clear();
        let read = match reader.read_until(b'\n', &mut line_buf) {
            Ok(read) => read,
            Err(error) => {
                return Err(format!(
                    "failed to search session '{}': {error}",
                    path.display()
                ));
            }
        };
        if read == 0 {
            break;
        }
        if session_id.is_some() {
            if message_finder.find(&line_buf).is_none() {
                continue;
            }
        } else if session_finder.find(&line_buf).is_none()
            && message_finder.find(&line_buf).is_none()
        {
            continue;
        }
        let Ok(line) = serde_json::from_slice::<RawSessionLine>(&line_buf) else {
            continue;
        };
        if session_id.is_none() && line.kind.as_deref() == Some("session") {
            session_id = line.id;
            continue;
        }
        if line.kind.as_deref() != Some("message") {
            continue;
        }
        let Some(message) = line.message else {
            continue;
        };
        let role = message.role.as_deref();
        if !matches!(role, Some("user" | "assistant")) {
            continue;
        }
        let Some(text) = searchable_raw_content(message.content.as_ref()) else {
            continue;
        };
        let folded = text.to_lowercase();
        if !folded.contains(query_folded) {
            continue;
        }
        let Some(session_id) = session_id.as_ref() else {
            continue;
        };
        matches.push(SessionSearchMatch {
            session_path: path.to_string_lossy().into_owned(),
            session_id: session_id.clone(),
            role: role.unwrap_or_default().to_owned(),
            snippet: search_snippet_folded(&text, &folded, query_folded),
            timestamp: line.timestamp.or(message.timestamp),
        });
        if matches.len() >= limit {
            break;
        }
    }
    Ok(())
}

fn compact_searchable_text(text: &str) -> Option<String> {
    let mut compact = String::with_capacity(text.len().min(MAX_SEARCHABLE_MESSAGE_CHARS));
    let mut char_count = 0_usize;
    for word in text.split_whitespace() {
        if !compact.is_empty() {
            if char_count >= MAX_SEARCHABLE_MESSAGE_CHARS {
                break;
            }
            compact.push(' ');
            char_count += 1;
        }
        for ch in word.chars() {
            if char_count >= MAX_SEARCHABLE_MESSAGE_CHARS {
                break;
            }
            compact.push(ch);
            char_count += 1;
        }
        if char_count >= MAX_SEARCHABLE_MESSAGE_CHARS {
            break;
        }
    }
    (!compact.is_empty()).then_some(compact)
}

fn searchable_raw_content(content: Option<&RawContent>) -> Option<String> {
    let mut text = String::new();
    match content? {
        RawContent::Text(value) => text.push_str(value),
        RawContent::Parts(parts) => {
            let mut char_count = 0_usize;
            for part in parts {
                if matches!(part.kind.as_deref(), Some("text" | "thinking") | None)
                    && let Some(value) = part.text.as_deref()
                {
                    if !text.is_empty() {
                        text.push(' ');
                        char_count += 1;
                    }
                    text.push_str(value);
                    char_count += value.chars().count();
                    if char_count >= MAX_SEARCHABLE_MESSAGE_CHARS {
                        break;
                    }
                }
            }
        }
        RawContent::Other(_) => return None,
    }
    compact_searchable_text(&text)
}

#[cfg(test)]
fn searchable_message_text(content: Option<&Value>) -> Option<String> {
    let mut text = String::new();
    match content? {
        Value::String(value) => text.push_str(value),
        Value::Array(parts) => {
            let mut char_count = 0_usize;
            for part in parts {
                let part_type = part.get("type").and_then(Value::as_str);
                if matches!(part_type, Some("text" | "thinking") | None)
                    && let Some(value) = part.get("text").and_then(Value::as_str)
                {
                    if !text.is_empty() {
                        text.push(' ');
                        char_count += 1;
                    }
                    text.push_str(value);
                    char_count += value.chars().count();
                    if char_count >= MAX_SEARCHABLE_MESSAGE_CHARS {
                        break;
                    }
                }
            }
        }
        _ => return None,
    }
    compact_searchable_text(&text)
}

#[cfg(test)]
fn search_snippet(text: &str, query_folded: &str) -> String {
    let folded = text.to_lowercase();
    search_snippet_folded(text, &folded, query_folded)
}

fn search_snippet_folded(text: &str, folded: &str, query_folded: &str) -> String {
    let byte_index = folded.find(query_folded).unwrap_or(0);
    let match_char = folded[..byte_index.min(folded.len())].chars().count();
    let before = 70;
    let start = match_char.saturating_sub(before);
    let end = start + MAX_SNIPPET_CHARS;
    let mut start_byte = None;
    let mut end_byte = text.len();
    let mut truncated_end = false;
    for (char_index, (byte_pos, _)) in text.char_indices().enumerate() {
        if char_index == start {
            start_byte = Some(byte_pos);
        }
        if char_index == end {
            end_byte = byte_pos;
            truncated_end = true;
            break;
        }
    }
    let slice = match start_byte {
        Some(start_byte) => &text[start_byte..end_byte],
        None => "",
    };
    let mut snippet = String::with_capacity(slice.len() + 6);
    if start > 0 {
        snippet.push('…');
    }
    snippet.push_str(slice);
    if truncated_end {
        snippet.push('…');
    }
    snippet
}

#[cfg(test)]
mod tests {
    use super::{search_snippet, searchable_message_text};
    use serde_json::json;

    #[test]
    fn extracts_text_without_tool_payloads() {
        let content = json!([
            { "type": "thinking", "text": "reasoning" },
            { "type": "toolCall", "arguments": { "secret": "needle" } },
            { "type": "text", "text": "answer needle" }
        ]);
        let text = searchable_message_text(Some(&content)).unwrap();
        assert_eq!(text, "reasoning answer needle");
    }

    #[test]
    fn snippet_keeps_match_visible() {
        let text = format!("{}needle{}", "a".repeat(120), "b".repeat(180));
        let snippet = search_snippet(&text, "needle");
        assert!(snippet.contains("needle"));
        assert!(snippet.starts_with('…'));
        assert!(snippet.ends_with('…'));
    }
}
