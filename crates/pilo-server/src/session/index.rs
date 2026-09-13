use std::{
    collections::HashMap,
    io::Read,
    path::PathBuf,
    sync::{
        Mutex as StdMutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::UNIX_EPOCH,
};

use pilo_protocol::SessionFile;
use serde::Deserialize;
use serde_json::Value;

use super::{agent_dir, session_dir_key};
use crate::to_value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionScanParams {
    project: String,
    #[serde(default)]
    known: Vec<SessionScanKnownFile>,
    #[serde(default)]
    summary_limit: Option<usize>,
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionScanKnownFile {
    path: String,
    size: u64,
    mtime_ns: u64,
}

pub(crate) const SESSION_INDEX_HEADER_BYTES: usize = 16 * 1024;
pub(crate) const SESSION_INDEX_PREFIX_BYTES: usize = 32 * 1024;
pub(crate) const SESSION_INDEX_TAIL_BYTES: usize = 32 * 1024;
const SESSION_INDEX_PREVIEW_CHARS: usize = 160;

pub(crate) fn session_scan(params: SessionScanParams) -> Result<Value, String> {
    let known = params
        .known
        .into_iter()
        .map(|file| (file.path, (file.size, file.mtime_ns)))
        .collect::<HashMap<_, _>>();
    let Some(root) =
        agent_dir().map(|root| root.join("sessions").join(session_dir_key(&params.project)))
    else {
        return to_value(Vec::<SessionFile>::new());
    };

    let explicit_paths = !params.paths.is_empty();
    let mut paths = if !explicit_paths {
        let Ok(entries) = std::fs::read_dir(&root) else {
            return to_value(Vec::<SessionFile>::new());
        };
        entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
            .collect::<Vec<_>>()
    } else {
        params
            .paths
            .into_iter()
            .map(PathBuf::from)
            .filter(|path| path.parent() == Some(root.as_path()))
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
            .collect::<Vec<_>>()
    };

    if !explicit_paths
        && known.is_empty()
        && let Some(summary_limit) = params.summary_limit
    {
        paths.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
        let deferred_paths = if paths.len() > summary_limit {
            paths.split_off(summary_limit)
        } else {
            Vec::new()
        };
        let mut files = summarize_session_files(session_file_stats(paths))?;
        files.extend(deferred_paths.into_iter().map(|path| SessionFile {
            path: path.to_string_lossy().into_owned(),
            size: 0,
            mtime_ns: 0,
            header: Value::Null,
            unchanged: false,
            deferred: true,
            name: None,
            first_user_message_preview: None,
        }));
        return to_value(files);
    }

    let mut candidates = session_file_stats(paths);

    candidates.sort_by(|left, right| {
        right
            .mtime_ns
            .cmp(&left.mtime_ns)
            .then_with(|| right.path_text.cmp(&left.path_text))
    });

    let summary_limit = params.summary_limit.unwrap_or(usize::MAX);
    let mut summaries_started = 0_usize;
    let mut files = vec![None; candidates.len()];
    let mut summarize_indices = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let unchanged = known
            .get(&candidate.path_text)
            .is_some_and(|fingerprint| *fingerprint == (candidate.size, candidate.mtime_ns));
        if unchanged {
            files[index] = Some(SessionFile {
                path: candidate.path_text.clone(),
                size: candidate.size,
                mtime_ns: candidate.mtime_ns,
                header: Value::Null,
                unchanged: true,
                deferred: false,
                name: None,
                first_user_message_preview: None,
            });
            continue;
        }

        if summaries_started >= summary_limit {
            files[index] = Some(SessionFile {
                path: candidate.path_text.clone(),
                size: candidate.size,
                mtime_ns: candidate.mtime_ns,
                header: Value::Null,
                unchanged: false,
                deferred: true,
                name: None,
                first_user_message_preview: None,
            });
            continue;
        }
        summaries_started += 1;
        summarize_indices.push(index);
    }

    if !summarize_indices.is_empty() {
        let worker_count = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(4)
            .min(8)
            .min(summarize_indices.len());
        let next = AtomicUsize::new(0);
        let results = StdMutex::new(Vec::with_capacity(summarize_indices.len()));
        std::thread::scope(|scope| {
            for _ in 0..worker_count {
                scope.spawn(|| {
                    loop {
                        let work_index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(candidate_index) = summarize_indices.get(work_index).copied()
                        else {
                            break;
                        };
                        let result = summarize_session_file(&candidates[candidate_index]);
                        results
                            .lock()
                            .expect("session summary results poisoned")
                            .push((candidate_index, result));
                    }
                });
            }
        });
        for (index, result) in results
            .into_inner()
            .expect("session summary results poisoned")
        {
            files[index] = result?;
        }
    }

    to_value(files.into_iter().flatten().collect::<Vec<_>>())
}

struct SessionFileStat {
    path: PathBuf,
    path_text: String,
    size: u64,
    mtime_ns: u64,
}

fn session_file_stats(paths: Vec<PathBuf>) -> Vec<SessionFileStat> {
    if paths.is_empty() {
        return Vec::new();
    }
    let worker_count = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(4)
        .min(8)
        .min(paths.len());
    let next = AtomicUsize::new(0);
    let results = StdMutex::new(Vec::with_capacity(paths.len()));
    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(path) = paths.get(index) else {
                        break;
                    };
                    if let Some(stat) = session_file_stat(path.clone()) {
                        results
                            .lock()
                            .expect("session stat results poisoned")
                            .push(stat);
                    }
                }
            });
        }
    });
    results.into_inner().expect("session stat results poisoned")
}

fn summarize_session_files(candidates: Vec<SessionFileStat>) -> Result<Vec<SessionFile>, String> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let worker_count = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(4)
        .min(8)
        .min(candidates.len());
    let next = AtomicUsize::new(0);
    let results = StdMutex::new(Vec::with_capacity(candidates.len()));
    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(candidate) = candidates.get(index) else {
                        break;
                    };
                    let result = summarize_session_file(candidate);
                    results
                        .lock()
                        .expect("session summary results poisoned")
                        .push((index, result));
                }
            });
        }
    });
    let mut results = results
        .into_inner()
        .expect("session summary results poisoned");
    results.sort_by_key(|(index, _)| *index);
    let mut files = Vec::with_capacity(results.len());
    for (_, result) in results {
        if let Some(file) = result? {
            files.push(file);
        }
    }
    Ok(files)
}

fn session_file_stat(path: PathBuf) -> Option<SessionFileStat> {
    let metadata = std::fs::metadata(&path).ok()?;
    let size = metadata.len();
    let mtime_ns = metadata
        .modified()
        .ok()
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

fn summarize_session_file(candidate: &SessionFileStat) -> Result<Option<SessionFile>, String> {
    use std::io::{BufRead as _, Seek as _, SeekFrom};

    let file = match std::fs::File::open(&candidate.path) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let mut reader = std::io::BufReader::new(file);
    let mut line = String::new();
    {
        let mut limited_header = reader.by_ref().take(SESSION_INDEX_HEADER_BYTES as u64);
        if limited_header.read_line(&mut line).is_err() {
            return Ok(None);
        }
    }
    if !line.ends_with('\n') && candidate.size > line.len() as u64 {
        return Ok(None);
    }
    let Ok(header) = serde_json::from_str(line.trim()) else {
        return Ok(None);
    };

    let mut prefix = Vec::with_capacity(SESSION_INDEX_PREFIX_BYTES);
    reader
        .by_ref()
        .take(SESSION_INDEX_PREFIX_BYTES as u64)
        .read_to_end(&mut prefix)
        .map_err(|error| format!("failed to read session index prefix: {error}"))?;

    let mut tail = Vec::new();
    if candidate.size > SESSION_INDEX_TAIL_BYTES as u64 {
        let mut file = reader.into_inner();
        file.seek(SeekFrom::Start(
            candidate.size - SESSION_INDEX_TAIL_BYTES as u64,
        ))
        .map_err(|error| format!("failed to seek session index tail: {error}"))?;
        file.take(SESSION_INDEX_TAIL_BYTES as u64)
            .read_to_end(&mut tail)
            .map_err(|error| format!("failed to read session index tail: {error}"))?;
    }
    let (name, first_user_message_preview) = summarize_session_index(&prefix, &tail);
    Ok(Some(SessionFile {
        path: candidate.path_text.clone(),
        size: candidate.size,
        mtime_ns: candidate.mtime_ns,
        header,
        unchanged: false,
        deferred: false,
        name,
        first_user_message_preview,
    }))
}

pub(crate) fn summarize_session_index(
    prefix: &[u8],
    tail: &[u8],
) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut first_user_message_preview = None;
    for value in complete_json_lines(prefix, false) {
        update_session_index_summary(&value, &mut name, &mut first_user_message_preview);
    }
    for value in complete_json_lines(tail, true) {
        update_session_index_summary(&value, &mut name, &mut first_user_message_preview);
    }
    (name, first_user_message_preview)
}

fn complete_json_lines(bytes: &[u8], drop_first_partial: bool) -> impl Iterator<Item = Value> + '_ {
    let start = if drop_first_partial {
        bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(bytes.len())
    } else {
        0
    };
    let end = bytes[start..]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|index| start + index + 1)
        .unwrap_or(start);
    bytes[start..end]
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
}

fn update_session_index_summary(
    value: &Value,
    name: &mut Option<String>,
    first_user_message_preview: &mut Option<String>,
) {
    match value.get("type").and_then(Value::as_str) {
        Some("session_info") => {
            if let Some(next) = value.get("name").and_then(Value::as_str) {
                *name = Some(next.to_owned());
            }
        }
        Some("message") if first_user_message_preview.is_none() => {
            if value.pointer("/message/role").and_then(Value::as_str) != Some("user") {
                return;
            }
            *first_user_message_preview =
                extract_session_preview(value.pointer("/message/content"));
        }
        _ => {}
    }
}

fn extract_session_preview(content: Option<&Value>) -> Option<String> {
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
    (!compact.is_empty()).then(|| compact.chars().take(SESSION_INDEX_PREVIEW_CHARS).collect())
}
