use pilo_protocol::SessionFile;
use serde_json::Value;
use tauri::AppHandle;

use crate::domain::{SessionIndexEntry, SessionReconcileResult, Workspace};

use super::{server_client::ServerManager, storage};

const PREVIEW_CHARS: usize = 160;

#[derive(Debug)]
struct SessionFileMeta {
    path: String,
    size: u64,
    mtime_ns: u64,
    header: Value,
}

pub fn list_cached(app: &AppHandle, workspace_id: &str) -> Result<Vec<SessionIndexEntry>, String> {
    storage::list_sessions(&storage::open(app)?, workspace_id)
}

pub async fn reconcile(
    app: &AppHandle,
    servers: &ServerManager,
    workspace: &Workspace,
) -> Result<SessionReconcileResult, String> {
    let files = scan_files(servers, workspace).await?;
    let db = storage::open(app)?;
    let mut result = SessionReconcileResult::default();
    let mut seen = Vec::new();

    for file in files {
        if file.header.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        if file.header.get("cwd").and_then(Value::as_str) != Some(workspace.path.as_str()) {
            continue;
        }

        seen.push(file.path.clone());
        let previous = storage::get_session(&db, &file.path)?;
        if previous.as_ref().is_some_and(|cached| {
            cached.file_size == file.size && cached.file_mtime_ns == file.mtime_ns
        }) {
            result.unchanged += 1;
            continue;
        }

        let pi_session_id = file
            .header
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("session '{}' has no id", file.path))?;
        let append_offset = previous
            .as_ref()
            .filter(|cached| {
                cached.pi_session_id == pi_session_id
                    && cached.file_size < file.size
                    && cached.last_offset <= cached.file_size
            })
            .map(|cached| cached.last_offset)
            .unwrap_or(0);
        let bytes = read_file(servers, workspace, &file.path, append_offset).await?;
        let entry = parse_file(workspace, file, previous.as_ref(), append_offset, &bytes)?;
        storage::upsert_session(&db, &entry)?;
        if previous.is_some() {
            result.updated += 1;
        } else {
            result.added += 1;
        }
    }

    result.removed = storage::remove_missing_sessions(&db, &workspace.id, &seen)?;
    result.sessions = storage::list_sessions(&db, &workspace.id)?;
    Ok(result)
}

async fn scan_files(
    servers: &ServerManager,
    workspace: &Workspace,
) -> Result<Vec<SessionFileMeta>, String> {
    let files: Vec<SessionFile> = servers
        .request_typed(
            &workspace.connection,
            "session.scan",
            serde_json::json!({ "workspace": workspace.path }),
        )
        .await?;
    Ok(files
        .into_iter()
        .map(|file| SessionFileMeta {
            path: file.path,
            size: file.size,
            mtime_ns: file.mtime_ns,
            header: file.header,
        })
        .collect())
}

async fn read_file(
    servers: &ServerManager,
    workspace: &Workspace,
    path: &str,
    offset: u64,
) -> Result<Vec<u8>, String> {
    const CHUNK_BYTES: usize = 8 * 1024 * 1024;

    let mut cursor = offset;
    let mut data = Vec::new();
    loop {
        let (metadata, binary) = servers
            .request_with_binary(
                &workspace.connection,
                "session.read",
                serde_json::json!({
                    "path": path,
                    "offset": cursor,
                    "limit": CHUNK_BYTES,
                }),
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
        let expected_offset = cursor.saturating_add(chunk.len() as u64);
        if next_offset != expected_offset {
            return Err(format!(
                "invalid pilo-server session chunk offset: expected {expected_offset}, got {next_offset}"
            ));
        }
        data.extend_from_slice(&chunk);
        if eof {
            return Ok(data);
        }
        if chunk.is_empty() {
            return Err("pilo-server returned an empty non-terminal session chunk".to_owned());
        }
        cursor = next_offset;
    }
}

fn parse_file(
    workspace: &Workspace,
    file: SessionFileMeta,
    previous: Option<&SessionIndexEntry>,
    offset: u64,
    bytes: &[u8],
) -> Result<SessionIndexEntry, String> {
    let pi_session_id = file
        .header
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("session '{}' has no id", file.path))?
        .to_owned();
    let cwd = file
        .header
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or(&workspace.path)
        .to_owned();
    let created_at = file
        .header
        .get("timestamp")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let incremental = offset > 0;
    let mut name = if incremental {
        previous.and_then(|value| value.name.clone())
    } else {
        None
    };
    let mut message_count = if incremental {
        previous.map(|value| value.message_count).unwrap_or(0)
    } else {
        0
    };
    let mut last_message_at = if incremental {
        previous.and_then(|value| value.last_message_at.clone())
    } else {
        None
    };
    let mut first_preview = if incremental {
        previous.and_then(|value| value.first_user_message_preview.clone())
    } else {
        None
    };
    let mut updated_at = if incremental {
        previous
            .map(|value| value.updated_at.clone())
            .unwrap_or_else(|| created_at.clone())
    } else {
        created_at.clone()
    };

    let complete_len = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let parsed_offset = offset.saturating_add(complete_len as u64);

    for line in bytes[..complete_len].split(|byte| *byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str)
            && timestamp > updated_at.as_str()
        {
            updated_at = timestamp.to_owned();
        }
        match value.get("type").and_then(Value::as_str) {
            Some("session_info") => {
                if let Some(next) = value.get("name").and_then(Value::as_str) {
                    name = Some(next.to_owned());
                }
            }
            Some("message") => {
                message_count += 1;
                if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
                    last_message_at = Some(timestamp.to_owned());
                }
                if first_preview.is_none()
                    && value.pointer("/message/role").and_then(Value::as_str) == Some("user")
                {
                    first_preview = extract_preview(value.pointer("/message/content"));
                }
            }
            _ => {}
        }
    }

    Ok(SessionIndexEntry {
        connection_id: workspace.connection.id.clone(),
        workspace_id: workspace.id.clone(),
        pi_session_id,
        session_path: file.path,
        name,
        cwd,
        created_at,
        updated_at,
        message_count,
        last_message_at,
        first_user_message_preview: first_preview,
        file_size: file.size,
        file_mtime_ns: file.mtime_ns,
        last_offset: parsed_offset,
        indexed_at_ms: storage::now_ms(),
        pinned: previous.is_some_and(|value| value.pinned),
        archived: previous.is_some_and(|value| value.archived),
        title_override: previous.and_then(|value| value.title_override.clone()),
    })
}

fn extract_preview(content: Option<&Value>) -> Option<String> {
    let text = match content? {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        None
    } else {
        Some(compact.chars().take(PREVIEW_CHARS).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Connection, ConnectionKind, WorkspaceMetadata};

    fn test_workspace() -> Workspace {
        Workspace {
            id: "workspace:local:/work".to_owned(),
            name: "work".to_owned(),
            path: "/work".to_owned(),
            connection: Connection {
                id: "local".to_owned(),
                name: "Local".to_owned(),
                kind: ConnectionKind::Local,
            },
            metadata: WorkspaceMetadata {
                cwd: "/work".to_owned(),
                git_branch: Some("main".to_owned()),
                pi_version: "1.0.0".to_owned(),
                refreshed_at_ms: 1,
            },
            created_at_ms: 1,
            last_opened_at_ms: 1,
        }
    }

    #[test]
    fn preview_extracts_user_text_parts() {
        let value = serde_json::json!([
            {"type":"text","text":"hello"},
            {"type":"text","text":"world"}
        ]);
        assert_eq!(
            extract_preview(Some(&value)).as_deref(),
            Some("hello world")
        );
    }

    #[test]
    fn append_only_parse_reuses_cached_metadata_from_last_offset() {
        let workspace = test_workspace();
        let header = serde_json::json!({
            "type": "session",
            "id": "session-a",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "cwd": "/work"
        });
        let initial = concat!(
            "{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":\"/work\"}\n",
            "{\"type\":\"message\",\"timestamp\":\"2026-01-01T00:01:00.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello world\"}]}}\n"
        )
        .as_bytes();
        let first = parse_file(
            &workspace,
            SessionFileMeta {
                path: "/sessions/a.jsonl".to_owned(),
                size: initial.len() as u64,
                mtime_ns: 1,
                header: header.clone(),
            },
            None,
            0,
            initial,
        )
        .unwrap();
        assert_eq!(first.message_count, 1);
        assert_eq!(
            first.first_user_message_preview.as_deref(),
            Some("hello world")
        );
        assert_eq!(first.last_offset, initial.len() as u64);

        let appended = concat!(
            "{\"type\":\"session_info\",\"timestamp\":\"2026-01-01T00:02:00.000Z\",\"name\":\"Renamed\"}\n",
            "{\"type\":\"message\",\"timestamp\":\"2026-01-01T00:03:00.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"reply\"}]}}\n"
        )
        .as_bytes();
        let total_size = (initial.len() + appended.len()) as u64;
        let second = parse_file(
            &workspace,
            SessionFileMeta {
                path: "/sessions/a.jsonl".to_owned(),
                size: total_size,
                mtime_ns: 2,
                header,
            },
            Some(&first),
            first.last_offset,
            appended,
        )
        .unwrap();

        assert_eq!(second.message_count, 2);
        assert_eq!(second.name.as_deref(), Some("Renamed"));
        assert_eq!(
            second.first_user_message_preview.as_deref(),
            Some("hello world")
        );
        assert_eq!(second.updated_at, "2026-01-01T00:03:00.000Z");
        assert_eq!(second.last_offset, total_size);
    }
}
