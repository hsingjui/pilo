use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Mutex as StdMutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use pilo_protocol::SessionFile;
use serde::Deserialize;
use serde_json::Value;

use super::{
    SessionFileStat, can_reuse_untitled_summary, session_file_stat, summarize_session_file,
};
use crate::{
    session::{agent_dir, session_dir_key},
    to_value,
};

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
    #[serde(default)]
    recover_name: bool,
}

pub(crate) fn session_scan(params: SessionScanParams) -> Result<Value, String> {
    let known = params
        .known
        .into_iter()
        .map(|file| (file.path, (file.size, file.mtime_ns, file.recover_name)))
        .collect::<HashMap<_, _>>();
    let Some(root) =
        agent_dir().map(|root| root.join("sessions").join(session_dir_key(&params.project)))
    else {
        return to_value(Vec::<SessionFile>::new());
    };

    let explicit_paths = !params.paths.is_empty();
    let mut paths = if !explicit_paths {
        let entries = match std::fs::read_dir(&root) {
            Ok(entries) => entries.collect::<Result<Vec<_>, _>>(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return to_value(Vec::<SessionFile>::new());
            }
            Err(error) => return Err(format!("failed to scan session directory: {error}")),
        }
        .map_err(|error| format!("failed to list session directory: {error}"))?;
        entries
            .into_iter()
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
        let mut files = summarize_session_files(session_file_stats(paths), &params.project)?;
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
        let unchanged =
            known
                .get(&candidate.path_text)
                .is_some_and(|&(size, mtime_ns, recover_name)| {
                    if (size, mtime_ns) != (candidate.size, candidate.mtime_ns) {
                        return false;
                    }
                    if !recover_name {
                        return true;
                    }
                    can_reuse_untitled_summary(candidate)
                });
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
                        let result =
                            summarize_session_file(&candidates[candidate_index], &params.project);
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

fn summarize_session_files(
    candidates: Vec<SessionFileStat>,
    project: &str,
) -> Result<Vec<SessionFile>, String> {
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
                    let result = summarize_session_file(candidate, project);
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
