mod project_scan;
mod summary;

use std::{
    collections::HashMap,
    io::{BufRead, Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{Mutex as StdMutex, OnceLock},
    time::{Instant, UNIX_EPOCH},
};

use pilo_protocol::SessionFile;
use serde_json::Value;

pub(crate) use project_scan::session_scan;
pub(crate) use summary::scan_index;
use summary::{SESSION_INDEX_MAX_PARSE_BYTES, scan_index_windows, scan_session_name};
#[cfg(test)]
pub(crate) use summary::{
    SESSION_INDEX_PREFIX_STAGES, SESSION_INDEX_TAIL_BYTES, SessionIndexSummary,
    summarize_index_bytes,
};

#[cfg(test)]
mod tests;

struct SessionNameScan {
    size: u64,
    mtime_ns: u64,
    header: Value,
    name: Option<String>,
    boundary: Vec<u8>,
    accessed_at: Instant,
}

fn session_name_scans() -> &'static StdMutex<HashMap<PathBuf, SessionNameScan>> {
    static SCANS: OnceLock<StdMutex<HashMap<PathBuf, SessionNameScan>>> = OnceLock::new();
    SCANS.get_or_init(|| StdMutex::new(HashMap::new()))
}

pub(crate) const SESSION_INDEX_HEADER_BYTES: usize = 16 * 1024;
const SESSION_NAME_SCAN_CACHE_LIMIT: usize = 256;
const SESSION_NAME_SCAN_BOUNDARY_BYTES: u64 = 256;

struct SessionFileStat {
    path: PathBuf,
    path_text: String,
    size: u64,
    mtime_ns: u64,
}

fn can_reuse_untitled_summary(candidate: &SessionFileStat) -> bool {
    let mut scans = session_name_scans()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    scans.get_mut(&candidate.path).is_some_and(|scan| {
        scan.accessed_at = Instant::now();
        (scan.size, scan.mtime_ns) == (candidate.size, candidate.mtime_ns)
            && scan
                .name
                .as_deref()
                .is_none_or(|name| name.trim().is_empty())
    })
}

fn session_file_stat(path: PathBuf) -> Option<SessionFileStat> {
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => None,
    };
    let size = metadata.as_ref().map_or(0, std::fs::Metadata::len);
    let mtime_ns = metadata
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos() as u64)
        .unwrap_or(0);
    Some(SessionFileStat {
        path_text: path.to_string_lossy().into_owned(),
        path,
        size,
        mtime_ns,
    })
}

fn summarize_session_file(
    candidate: &SessionFileStat,
    project: &str,
) -> Result<Option<SessionFile>, String> {
    let file = read_session_summary(candidate, project)?.unwrap_or_else(|| {
        eprintln!(
            "[session-index] cannot read session header: {}",
            candidate.path_text
        );
        // Keep an observed but unreadable path so the Host does not treat it as deleted.
        SessionFile {
            path: candidate.path_text.clone(),
            size: candidate.size,
            mtime_ns: candidate.mtime_ns,
            header: Value::Null,
            unchanged: false,
            deferred: false,
            name: None,
            first_user_message_preview: None,
            name_scanned: false,
        }
    });
    Ok(Some(file))
}

fn read_session_summary(
    candidate: &SessionFileStat,
    project: &str,
) -> Result<Option<SessionFile>, String> {
    let file = match std::fs::File::open(&candidate.path) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    read_session_summary_from(candidate, project, &file, || file.metadata().ok())
}

fn read_session_summary_from<R: Read + Seek>(
    candidate: &SessionFileStat,
    project: &str,
    source: R,
    metadata: impl FnOnce() -> Option<std::fs::Metadata>,
) -> Result<Option<SessionFile>, String> {
    let mut reader = std::io::BufReader::new(source);
    let mut line = String::new();
    let mut consumed = 0;
    let header = loop {
        line.clear();
        let mut limited_header = reader
            .by_ref()
            .take((SESSION_INDEX_HEADER_BYTES - consumed) as u64);
        let Ok(read) = limited_header.read_line(&mut line) else {
            return Ok(None);
        };
        consumed += read;
        if read == 0 || (!line.ends_with('\n') && candidate.size > consumed as u64) {
            return Ok(None);
        }
        if let Ok(value) = serde_json::from_str::<Value>(line.trim().trim_start_matches('\u{feff}'))
        {
            if value.get("type").and_then(Value::as_str) == Some("session") {
                break value;
            }
            let pi_message = value.get("type").and_then(Value::as_str) == Some("message")
                && value
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.is_empty())
                && matches!(
                    value.pointer("/message/role").and_then(Value::as_str),
                    Some("user" | "assistant" | "toolResult")
                );
            if !pi_message {
                return Ok(None);
            }
            let Some(header) = recover_session_header(&candidate.path, project) else {
                return Ok(None);
            };
            eprintln!(
                "[session-index] indexing headerless session as read-only: {}",
                candidate.path_text
            );
            // Include the first message in the summary; recovery never changes the JSONL.
            reader
                .seek(SeekFrom::Start(0))
                .map_err(|error| error.to_string())?;
            break header;
        }
        if consumed >= SESSION_INDEX_HEADER_BYTES {
            return Ok(None);
        }
    };

    let prefix_start = reader
        .stream_position()
        .map_err(|error| format!("failed to locate session index prefix: {error}"))?;
    let cached = session_name_scans()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&candidate.path)
        .filter(|scan| {
            scan.header == header
                && (candidate.size > scan.size
                    || (candidate.size, candidate.mtime_ns) == (scan.size, scan.mtime_ns))
        });
    // Pi JSONL is append-only; a changed header/boundary or same-size rewrite invalidates progress.
    let cached = match cached {
        Some(scan) if read_name_scan_boundary(&mut reader, scan.size)? == scan.boundary => {
            Some(scan)
        }
        _ => None,
    };
    // Boundary validation seeks away from the header; prefix scanning must start at the same offset.
    reader
        .seek(SeekFrom::Start(prefix_start))
        .map_err(|error| format!("failed to seek session index prefix: {error}"))?;
    let summary = if let Some(scan) = cached {
        let Some(mut summary) = scan_index_windows(&mut reader, candidate.size)? else {
            return Ok(None);
        };
        summary.name = scan.name;
        summary.name_scanned = true;
        if candidate.size > scan.size {
            // Overlap covers any parseable JSONL line split across writes, without rereading history.
            let start = scan
                .size
                .saturating_sub((SESSION_INDEX_MAX_PARSE_BYTES + 1) as u64);
            scan_session_name(&mut reader, candidate.size, start, &mut summary)?;
        }
        summary
    } else {
        let Some(summary) = scan_index(&mut reader, candidate.size)? else {
            return Ok(None);
        };
        summary
    };
    if summary.name_scanned {
        let boundary = read_name_scan_boundary(&mut reader, candidate.size)?;
        let metadata = metadata();
        let unchanged = metadata.as_ref().is_some_and(|metadata| {
            metadata.len() == candidate.size
                && metadata
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                    .map(|value| value.as_nanos() as u64)
                    == Some(candidate.mtime_ns)
        });
        if unchanged
            && boundary.len() as u64 == candidate.size.min(SESSION_NAME_SCAN_BOUNDARY_BYTES)
        {
            let mut scans = session_name_scans()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if scans.len() >= SESSION_NAME_SCAN_CACHE_LIMIT && !scans.contains_key(&candidate.path)
            {
                let oldest = scans
                    .iter()
                    .min_by_key(|(_, scan)| scan.accessed_at)
                    .map(|(path, _)| path.clone());
                if let Some(oldest) = oldest {
                    scans.remove(&oldest);
                }
            }
            scans.insert(
                candidate.path.clone(),
                SessionNameScan {
                    size: candidate.size,
                    mtime_ns: candidate.mtime_ns,
                    header: header.clone(),
                    name: summary.name.clone(),
                    boundary,
                    accessed_at: Instant::now(),
                },
            );
        }
    }
    Ok(Some(SessionFile {
        path: candidate.path_text.clone(),
        size: candidate.size,
        mtime_ns: candidate.mtime_ns,
        header,
        unchanged: false,
        deferred: false,
        name: summary.name,
        first_user_message_preview: summary.first_user_message_preview,
        name_scanned: summary.name_scanned,
    }))
}

fn read_name_scan_boundary<R: Read + Seek>(reader: &mut R, size: u64) -> Result<Vec<u8>, String> {
    reader
        .seek(SeekFrom::Start(
            size.saturating_sub(SESSION_NAME_SCAN_BOUNDARY_BYTES),
        ))
        .map_err(|error| format!("failed to seek session index boundary: {error}"))?;
    let mut boundary = Vec::new();
    reader
        .take(size.min(SESSION_NAME_SCAN_BOUNDARY_BYTES))
        .read_to_end(&mut boundary)
        .map_err(|error| format!("failed to read session index boundary: {error}"))?;
    Ok(boundary)
}

fn recover_session_header(path: &std::path::Path, project: &str) -> Option<Value> {
    let (timestamp, id) = path.file_stem()?.to_str()?.split_once('_')?;
    if id.len() != 36
        || !id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
        || timestamp.len() != 24
        || !timestamp
            .bytes()
            .enumerate()
            .all(|(index, byte)| match index {
                4 | 7 | 13 | 16 | 19 => byte == b'-',
                10 => byte == b'T',
                23 => byte == b'Z',
                _ => byte.is_ascii_digit(),
            })
    {
        return None;
    }
    let timestamp = format!(
        "{}T{}:{}:{}.{}Z",
        &timestamp[..10],
        &timestamp[11..13],
        &timestamp[14..16],
        &timestamp[17..19],
        &timestamp[20..23],
    );
    Some(serde_json::json!({
        "type": "session",
        "id": id,
        "timestamp": timestamp,
        "cwd": project,
    }))
}
