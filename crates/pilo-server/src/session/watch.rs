use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use notify::{Event, EventKind, RecursiveMode, Watcher};
use pilo_protocol::Envelope;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::{agent_dir, session_dir_key};
use crate::ServerState;

const SESSION_WATCH_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(150);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionWatchParams {
    stream_id: String,
    project: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionWatchStopParams {
    stream_id: String,
}
fn session_watch_paths(project: &str) -> Result<(PathBuf, PathBuf), String> {
    let agent = agent_dir().ok_or_else(|| "Pi agent directory is unavailable".to_owned())?;
    let target = agent.join("sessions").join(session_dir_key(project));
    let watch_root = nearest_watch_root(&target)
        .ok_or_else(|| format!("Pi agent directory '{}' is not accessible", agent.display()))?;
    Ok((target, watch_root))
}

/// The deepest existing directory on the way to the project's session
/// directory: the directory itself, else `sessions`, else the agent directory.
/// Pi keeps session files flat in it, so a non-recursive watch of it, or of
/// the parent its creation shows in, is enough.
fn nearest_watch_root(target: &Path) -> Option<PathBuf> {
    target
        .ancestors()
        .take(3)
        .find(|path| path.is_dir())
        .map(Path::to_path_buf)
}

fn watch_session_root(watcher: &mut impl Watcher, root: &Path) -> Result<(), String> {
    watcher
        .watch(root, RecursiveMode::NonRecursive)
        .map_err(|error| {
            format!(
                "failed to watch Pi session directory '{}': {error}",
                root.display()
            )
        })
}

/// Moves to the deepest existing root. Recheck after registering: a child
/// can appear before the new non-recursive watch can report its creation.
/// A root change asks for a full refresh to catch writes missed in transit.
fn rearm_watch(
    watcher: &mut impl Watcher,
    root: &mut PathBuf,
    target: &Path,
) -> Result<bool, String> {
    let mut changed = false;
    // There are three candidate directory levels; bound retries if they keep changing.
    for _ in 0..3 {
        let next = nearest_watch_root(target)
            .ok_or_else(|| "no accessible Pi session directory or parent to watch".to_owned())?;
        if next == *root {
            return Ok(changed);
        }
        // The old root may already be gone.
        let _ = watcher.unwatch(root);
        watch_session_root(watcher, &next)?;
        *root = next;
        changed = true;
    }
    Err("Pi session watch root kept changing during registration".to_owned())
}

pub(crate) fn collect_session_change_paths(
    event: &Event,
    target: &Path,
    touched: &mut HashSet<PathBuf>,
    full_refresh: &mut bool,
) -> bool {
    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    ) {
        return false;
    }
    let mut matched = false;
    for path in &event.paths {
        if path == target {
            matched = true;
            *full_refresh = true;
            continue;
        }
        if path.starts_with(target)
            && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
        {
            matched = true;
            touched.insert(path.clone());
        }
    }
    matched
}

#[cfg(test)]
pub(crate) fn is_session_change(event: &Event, target: &Path) -> bool {
    let mut touched = HashSet::new();
    let mut full_refresh = false;
    collect_session_change_paths(event, target, &mut touched, &mut full_refresh)
}

pub(crate) async fn session_watch_start(
    state: &ServerState,
    params: SessionWatchParams,
) -> Result<Value, String> {
    if let Some(task) = state
        .session_watchers
        .lock()
        .await
        .remove(&params.stream_id)
    {
        task.abort();
    }

    let (target, mut watch_root) = session_watch_paths(&params.project)?;
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = event_tx.send(event);
    })
    .map_err(|error| format!("failed to create session watcher: {error}"))?;
    watch_session_root(&mut watcher, &watch_root)?;
    rearm_watch(&mut watcher, &mut watch_root, &target)?;

    let stream_id = params.stream_id.clone();
    let writer = state.writer.clone();
    let task = tokio::spawn(async move {
        let mut watcher = watcher;
        let mut watch_root = watch_root;
        if writer
            .send(Envelope::event(
                stream_id.clone(),
                "session.backend",
                json!({
                    "backend": "server-native",
                    "root": watch_root.to_string_lossy(),
                }),
            ))
            .await
            .is_err()
        {
            return;
        }

        'events: while let Some(event) = event_rx.recv().await {
            match event {
                Ok(event) => {
                    let mut touched = HashSet::new();
                    let mut errors = Vec::new();
                    let mut full_refresh = match rearm_watch(&mut watcher, &mut watch_root, &target)
                    {
                        Ok(changed) => changed,
                        Err(error) => {
                            errors.push(error);
                            true
                        }
                    };
                    if !collect_session_change_paths(
                        &event,
                        &target,
                        &mut touched,
                        &mut full_refresh,
                    ) && !full_refresh
                    {
                        continue;
                    }
                    let mut deadline = tokio::time::Instant::now() + SESSION_WATCH_DEBOUNCE;
                    let mut channel_closed = false;
                    loop {
                        match tokio::time::timeout_at(deadline, event_rx.recv()).await {
                            Ok(Some(Ok(next))) => {
                                let rearmed =
                                    match rearm_watch(&mut watcher, &mut watch_root, &target) {
                                        Ok(changed) => changed,
                                        Err(error) => {
                                            errors.push(error);
                                            true
                                        }
                                    };
                                full_refresh |= rearmed;
                                if collect_session_change_paths(
                                    &next,
                                    &target,
                                    &mut touched,
                                    &mut full_refresh,
                                ) || rearmed
                                {
                                    deadline = tokio::time::Instant::now() + SESSION_WATCH_DEBOUNCE;
                                }
                            }
                            Ok(Some(Err(error))) => errors.push(error.to_string()),
                            Ok(None) => {
                                channel_closed = true;
                                break;
                            }
                            Err(_) => break,
                        }
                    }
                    for message in errors {
                        if writer
                            .send(Envelope::event(
                                stream_id.clone(),
                                "session.error",
                                json!({ "message": message }),
                            ))
                            .await
                            .is_err()
                        {
                            break 'events;
                        }
                    }
                    let mut paths = Vec::new();
                    let mut removed_paths = Vec::new();
                    for path in touched {
                        let text = path.to_string_lossy().into_owned();
                        if path.is_file() {
                            paths.push(text);
                        } else {
                            removed_paths.push(text);
                        }
                    }
                    paths.sort_unstable();
                    removed_paths.sort_unstable();
                    if writer
                        .send(Envelope::event(
                            stream_id.clone(),
                            "session.changed",
                            json!({
                                "paths": paths,
                                "removedPaths": removed_paths,
                                "full": full_refresh,
                            }),
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                    if channel_closed {
                        break;
                    }
                }
                Err(error) => {
                    if writer
                        .send(Envelope::event(
                            stream_id.clone(),
                            "session.error",
                            json!({ "message": error.to_string() }),
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
    state
        .session_watchers
        .lock()
        .await
        .insert(params.stream_id, task);
    Ok(Value::Null)
}

pub(crate) async fn session_watch_stop(
    state: &ServerState,
    params: SessionWatchStopParams,
) -> Result<Value, String> {
    if let Some(task) = state
        .session_watchers
        .lock()
        .await
        .remove(&params.stream_id)
    {
        task.abort();
    }
    Ok(Value::Null)
}
