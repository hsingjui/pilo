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
    let reader = BufReader::new(file);
    let mut session_id = None;
    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                return Err(format!(
                    "failed to search session '{}': {error}",
                    path.display()
                ));
            }
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if session_id.is_none() && value.get("type").and_then(Value::as_str) == Some("session") {
            session_id = value.get("id").and_then(Value::as_str).map(str::to_owned);
            continue;
        }
        if value.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let role = value.pointer("/message/role").and_then(Value::as_str);
        if !matches!(role, Some("user" | "assistant")) {
            continue;
        }
        let Some(text) = searchable_message_text(value.pointer("/message/content")) else {
            continue;
        };
        if !text.to_lowercase().contains(query_folded) {
            continue;
        }
        let Some(session_id) = session_id.as_ref() else {
            continue;
        };
        matches.push(SessionSearchMatch {
            session_path: path.to_string_lossy().into_owned(),
            session_id: session_id.clone(),
            role: role.unwrap_or_default().to_owned(),
            snippet: search_snippet(&text, query_folded),
            timestamp: value
                .get("timestamp")
                .cloned()
                .or_else(|| value.pointer("/message/timestamp").cloned()),
        });
        if matches.len() >= limit {
            break;
        }
    }
    Ok(())
}

fn searchable_message_text(content: Option<&Value>) -> Option<String> {
    let mut text = String::new();
    match content? {
        Value::String(value) => text.push_str(value),
        Value::Array(parts) => {
            for part in parts {
                let part_type = part.get("type").and_then(Value::as_str);
                if matches!(part_type, Some("text" | "thinking") | None)
                    && let Some(value) = part.get("text").and_then(Value::as_str)
                {
                    if !text.is_empty() {
                        text.push(' ');
                    }
                    text.push_str(value);
                    if text.chars().count() >= MAX_SEARCHABLE_MESSAGE_CHARS {
                        break;
                    }
                }
            }
        }
        _ => return None,
    }
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!compact.is_empty()).then(|| {
        compact
            .chars()
            .take(MAX_SEARCHABLE_MESSAGE_CHARS)
            .collect::<String>()
    })
}

fn search_snippet(text: &str, query_folded: &str) -> String {
    let folded = text.to_lowercase();
    let byte_index = folded.find(query_folded).unwrap_or(0);
    let match_char = folded[..byte_index.min(folded.len())].chars().count();
    let chars = text.chars().collect::<Vec<_>>();
    let before = 70;
    let start = match_char.saturating_sub(before);
    let end = (start + MAX_SNIPPET_CHARS).min(chars.len());
    let mut snippet = chars[start..end].iter().collect::<String>();
    if start > 0 {
        snippet.insert(0, '…');
    }
    if end < chars.len() {
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
