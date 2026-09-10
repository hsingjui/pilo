use std::{
    env, fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde_json::Value;
use tauri::AppHandle;

use crate::domain::{ConnectionKind, SessionIndexEntry, SessionReconcileResult, Workspace};

use super::{
    ssh::{read_ssh_session_file, scan_ssh_session_files},
    storage,
    wsl::{read_wsl_session_file, scan_wsl_session_files},
};

const PREVIEW_CHARS: usize = 160;
const FILE_MARKER: u8 = 0x1e;

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
    workspace: &Workspace,
) -> Result<SessionReconcileResult, String> {
    let files = scan_files(workspace).await?;
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
        let bytes = read_file(workspace, &file.path, append_offset).await?;
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

async fn scan_files(workspace: &Workspace) -> Result<Vec<SessionFileMeta>, String> {
    match &workspace.connection.kind {
        ConnectionKind::Local => scan_local(),
        ConnectionKind::Wsl { distro } => {
            let blob = scan_wsl_session_files(distro.clone())
                .await
                .map_err(|error| error.to_string())?;
            parse_remote_metadata(&blob)
        }
        ConnectionKind::Ssh { target } => {
            let blob = scan_ssh_session_files(target.clone())
                .await
                .map_err(|error| error.to_string())?;
            parse_remote_metadata(&blob)
        }
    }
}

async fn read_file(workspace: &Workspace, path: &str, offset: u64) -> Result<Vec<u8>, String> {
    match &workspace.connection.kind {
        ConnectionKind::Local => read_local_file(path, offset),
        ConnectionKind::Wsl { distro } => {
            read_wsl_session_file(distro.clone(), path.to_owned(), offset)
                .await
                .map_err(|error| error.to_string())
        }
        ConnectionKind::Ssh { target } => {
            read_ssh_session_file(target.clone(), path.to_owned(), offset)
                .await
                .map_err(|error| error.to_string())
        }
    }
}

fn local_agent_dir() -> Option<PathBuf> {
    env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|value| PathBuf::from(value).join(".pi/agent")))
        .or_else(|| env::var_os("USERPROFILE").map(|value| PathBuf::from(value).join(".pi/agent")))
}

fn scan_local() -> Result<Vec<SessionFileMeta>, String> {
    let Some(root) = local_agent_dir().map(|value| value.join("sessions")) else {
        return Ok(Vec::new());
    };
    let mut paths = Vec::new();
    collect_jsonl(&root, &mut paths)?;
    paths.sort();
    paths.into_iter().filter_map(read_local_metadata).collect()
}

fn collect_jsonl(dir: &Path, paths: &mut Vec<PathBuf>) -> Result<(), String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, paths)?;
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            paths.push(path);
        }
    }
    Ok(())
}

fn read_local_metadata(path: PathBuf) -> Option<Result<SessionFileMeta, String>> {
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) => return Some(Err(format!("failed to stat '{}': {error}", path.display()))),
    };
    let file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) => return Some(Err(format!("failed to open '{}': {error}", path.display()))),
    };
    let mut line = String::new();
    if BufReader::new(file).read_line(&mut line).is_err() || line.trim().is_empty() {
        return None;
    }
    let header = match serde_json::from_str(line.trim()) {
        Ok(header) => header,
        Err(_) => return None,
    };
    let mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos() as u64)
        .unwrap_or(0);
    Some(Ok(SessionFileMeta {
        path: path.to_string_lossy().into_owned(),
        size: metadata.len(),
        mtime_ns,
        header,
    }))
}

fn read_local_file(path: &str, offset: u64) -> Result<Vec<u8>, String> {
    let mut file =
        fs::File::open(path).map_err(|error| format!("failed to open '{path}': {error}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("failed to seek '{path}' to {offset}: {error}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read '{path}': {error}"))?;
    Ok(bytes)
}

fn parse_remote_metadata(blob: &[u8]) -> Result<Vec<SessionFileMeta>, String> {
    let mut files = Vec::new();
    for chunk in blob.split(|byte| *byte == FILE_MARKER).skip(1) {
        let mut lines = chunk.splitn(3, |byte| *byte == b'\n');
        let metadata_line = lines.next().unwrap_or_default();
        let header_line = lines.next().unwrap_or_default();
        let metadata = String::from_utf8_lossy(metadata_line);
        let mut parts = metadata.split('\t');
        let path = parts.next().unwrap_or_default().to_owned();
        let size = parts
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let mtime_ns = parts
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        if path.is_empty() || header_line.is_empty() {
            continue;
        }
        let Ok(header) = serde_json::from_slice(header_line) else {
            continue;
        };
        files.push(SessionFileMeta {
            path,
            size,
            mtime_ns,
            header,
        });
    }
    Ok(files)
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
        if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
            if timestamp > updated_at.as_str() {
                updated_at = timestamp.to_owned();
            }
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
    use crate::domain::{Connection, WorkspaceMetadata};

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
    fn remote_metadata_protocol_parses_nanosecond_mtime() {
        let blob = b"\x1e/home/a.jsonl\t42\t123456789\n{\"type\":\"session\",\"id\":\"a\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"cwd\":\"/work\"}\n";
        let files = parse_remote_metadata(blob).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].size, 42);
        assert_eq!(files[0].mtime_ns, 123456789);
        assert_eq!(files[0].header["id"], "a");
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
