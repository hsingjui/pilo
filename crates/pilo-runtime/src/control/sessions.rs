use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use pilo_domain::{ConnectionKind, SessionIndexEntry, SessionUiStateUpdate};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{
    Runtime,
    chat_sessions::{ChatSessionState, PiCommandError, same_session_file},
    events::{EventBatch, EventQueueLimits, PiProcessState, RuntimeEvent},
    runtime_api, session_api, storage,
};

use super::{ControlCommand, encode, required};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    message: String,
    title: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Send {
    message: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Update {
    title: Option<String>,
    pinned: Option<bool>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Page {
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct History {
    start_message: Option<usize>,
    message_limit: Option<usize>,
}

pub(super) async fn execute(
    runtime: &Runtime,
    command: ControlCommand,
    source_project: &str,
    source_session: &str,
) -> Result<Value, String> {
    let project = required(command.project_id.as_deref(), "--project")?;
    if project != source_project || command.connection_id.is_some() {
        return Err(
            "session control requires the current --project, without --connection".to_owned(),
        );
    }
    let method = command.method.as_str();
    if method == "sessions.create" {
        return create(runtime, project, decode(command.value)?).await;
    }
    let states: Vec<_> = runtime
        .chat_sessions
        .persistent_states()
        .await
        .into_iter()
        .filter(|state| state.project_id == project && !is_fork_helper(state))
        .collect();
    if method == "sessions.list" {
        let page: Page = optional(command.value)?;
        let offset = page.offset.unwrap_or(0);
        let limit = page.limit.unwrap_or(50).clamp(1, 100);
        let entries = session_api::session_refresh_unwatched(runtime, project.clone()).await?;
        let next = offset.saturating_add(limit);
        let more = next < entries.len();
        let saved: Vec<_> = entries.into_iter().skip(offset).take(limit).collect();
        return Ok(json!({"saved": saved, "runtime": states, "nextOffset": more.then_some(next)}));
    }

    let id = required(command.key.as_deref(), "session ID")?;
    let entries = session_api::session_list(runtime, project.clone())?;
    let input_state = states.iter().find(|state| state.session_key == id);
    let entry = if let Some(state) = input_state.filter(|state| state.session_path.is_some()) {
        entries
            .iter()
            .find(|entry| owns_file(state, &entry.session_path))
    } else {
        entries.iter().find(|entry| {
            entry.pi_session_id == id || chat_key(&project, &entry.pi_session_id) == id
        })
    };
    let state = input_state.or_else(|| {
        entry.and_then(|entry| {
            let canonical_key = chat_key(&project, &entry.pi_session_id);
            states.iter().find(|state| {
                owns_file(state, &entry.session_path)
                    || (state.session_path.is_none() && state.session_key == canonical_key)
            })
        })
    });
    let key = state
        .map(|state| state.session_key.clone())
        .or_else(|| entry.map(|entry| chat_key(&project, &entry.pi_session_id)))
        .ok_or_else(|| "session not found in the specified project".to_owned())?;
    let path = entry
        .map(|entry| entry.session_path.as_str())
        .or_else(|| state.and_then(|state| state.session_path.as_deref()));
    let source = runtime.chat_sessions.state(source_session).await;
    let own_session = key == source_session
        || path.is_some_and(|path| source.as_ref().is_some_and(|state| owns_file(state, path)));
    if own_session
        && matches!(
            method,
            "sessions.send" | "sessions.abort" | "sessions.stop" | "sessions.delete"
        )
    {
        return Err("cannot send to, interrupt, stop or delete the calling session".to_owned());
    }

    match method {
        "sessions.get" => Ok(json!({"sessionKey": key, "saved": entry, "runtime": state})),
        "sessions.history" => {
            let args: History = optional(command.value)?;
            let limit = Some(args.message_limit.unwrap_or(24).clamp(1, 100));
            let path = path.ok_or("the session has not been saved yet")?;
            let history = session_api::session_history(
                runtime,
                project,
                path.to_owned(),
                None,
                None,
                args.start_message,
                limit,
                None,
            )
            .await?;
            if history.len() >= super::CONTROL_MAX_BYTES - 1024 {
                return Err(
                    "session history exceeds the CLI byte limit; request a smaller page".to_owned(),
                );
            }
            serde_json::from_slice(&history)
                .map_err(|_| "invalid session history response".to_owned())
        }
        "sessions.update" => encode(update(runtime, saved(entry)?, decode(command.value)?)?),
        "sessions.delete" => {
            let entry = saved(entry)?;
            if !source.is_some_and(|state| state.session_path.is_some()) {
                return Err(
                    "cannot safely delete until the calling session file is known".to_owned(),
                );
            }
            encode(
                session_api::remove_saved_session(
                    runtime,
                    project,
                    entry.session_path.clone(),
                    true,
                )
                .await?,
            )
        }
        "sessions.stop" => {
            if let Some(state) = state {
                runtime_api::chat_session_stop(
                    runtime,
                    state.session_key.clone(),
                    Some("ctl".to_owned()),
                )
                .await?;
            }
            Ok(json!({"sessionKey": key, "stopped": true}))
        }
        "sessions.abort" => {
            let state = state
                .filter(|state| state.snapshot.state == PiProcessState::Running)
                .ok_or("session is not running")?;
            let _policy = runtime.pi_resource_policy.read().await;
            call(runtime, &key, json!({"type": "abort"}), false)
                .await
                .map_err(PiCommandError::into_message)?;
            Ok(json!({"sessionKey": state.session_key, "abortRequested": true}))
        }
        "sessions.resume" | "sessions.send" => {
            let message = if method == "sessions.send" {
                let args: Send = decode(command.value)?;
                validate_message(&args.message)?;
                Some(args.message)
            } else {
                None
            };
            let snapshot = if let Some(state) = state.filter(|state| {
                state.initialized && state.snapshot.state == PiProcessState::Running
            }) {
                state.snapshot.clone()
            } else {
                let path = path.ok_or("the session has not been saved yet")?;
                start(runtime, project, key.clone(), Some(path.to_owned())).await?
            };
            if let Some(message) = message {
                let disposition = send(runtime, &key, message)
                    .await
                    .map_err(PiCommandError::into_message)?;
                Ok(json!({"sessionKey": key, "accepted": true, "disposition": disposition}))
            } else {
                Ok(json!({"sessionKey": key, "snapshot": snapshot}))
            }
        }
        _ => Err("unknown session control command".to_owned()),
    }
}

async fn create(runtime: &Runtime, project: String, args: Create) -> Result<Value, String> {
    validate_message(&args.message)?;
    if let Some(title) = &args.title {
        validate_title(title)?;
    }
    let key = chat_key(&project, &format!("ctl-{:032x}", random_id()?));
    start(runtime, project.clone(), key.clone(), None)
        .await
        .map_err(|error| format!("session {key}: {error}; first message was not sent"))?;
    if let Err(error) = session_api::session_watch_start(runtime, project).await {
        log::warn!("failed to watch CLI-created session's project: {error}");
    }
    let result = async {
        if let Some(title) = args.title {
            let _policy = runtime.pi_resource_policy.read().await;
            call(
                runtime,
                &key,
                json!({"type": "set_session_name", "name": title}),
                false,
            )
            .await
            .map_err(|error| {
                PiCommandError::NotAccepted(format!(
                    "could not set the session title: {}; first message was not sent",
                    error.into_message()
                ))
            })?;
        }
        send(runtime, &key, args.message).await
    }
    .await;
    let disposition = match result {
        Ok(disposition) => disposition,
        Err(error) => {
            let not_accepted = matches!(error, PiCommandError::NotAccepted(_));
            let message = error.into_message();
            if not_accepted
                && let Err(stop_error) = runtime
                    .chat_sessions
                    .stop(&key, Some("ctl_create_failed"))
                    .await
            {
                return Err(format!(
                    "session {key}: {message}; could not confirm Pi stopped: {stop_error}"
                ));
            }
            return Err(format!("session {key}: {message}"));
        }
    };
    let state = runtime.chat_sessions.state(&key).await;
    Ok(json!({"sessionKey": key, "accepted": true, "disposition": disposition, "runtime": state}))
}

fn random_id() -> Result<u128, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "failed to generate session ID".to_owned())?;
    Ok(u128::from_ne_bytes(bytes))
}

fn chat_key(project: &str, id: &str) -> String {
    json!([project, id]).to_string()
}

fn owns_file(state: &ChatSessionState, path: &str) -> bool {
    let local_windows = cfg!(windows)
        && state
            .snapshot
            .connection
            .as_ref()
            .is_some_and(|connection| matches!(connection.kind, ConnectionKind::Local));
    state
        .session_path
        .as_deref()
        .is_some_and(|candidate| same_session_file(candidate, path, local_windows))
}

fn is_fork_helper(state: &ChatSessionState) -> bool {
    serde_json::from_str::<[String; 2]>(&state.session_key)
        .is_ok_and(|[_, id]| id.starts_with("fork-runtime-"))
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value)
        .map_err(|_| "invalid session JSON; consult ctl --help for the expected fields".to_owned())
}

fn optional<T: DeserializeOwned + Default>(value: Value) -> Result<T, String> {
    if value.is_null() {
        Ok(T::default())
    } else {
        decode(value)
    }
}

fn saved(entry: Option<&SessionIndexEntry>) -> Result<&SessionIndexEntry, String> {
    entry.ok_or_else(|| "session is not indexed yet".to_owned())
}

fn validate_message(message: &str) -> Result<(), String> {
    let text = message.trim();
    if text.is_empty() || text.starts_with('/') || message.len() > 64 * 1024 {
        return Err(
            "message must be non-empty plain text (no slash commands; up to 64 KiB)".to_owned(),
        );
    }
    Ok(())
}

fn validate_title(title: &str) -> Result<(), String> {
    if title.trim().is_empty() || title.len() > 512 || title.chars().any(char::is_control) {
        return Err("title must be non-empty single-line text (up to 512 bytes)".to_owned());
    }
    Ok(())
}

fn update(
    runtime: &Runtime,
    entry: &SessionIndexEntry,
    patch: Update,
) -> Result<SessionIndexEntry, String> {
    if let Some(title) = &patch.title {
        validate_title(title)?;
    } else if patch.pinned.is_none() {
        return Err("session update requires title or pinned".to_owned());
    }
    let mut db = storage::open(&runtime.paths)?;
    let transaction = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    storage::get_session(&transaction, &entry.session_path, Some(&entry.project_id))?
        .ok_or("session is no longer indexed")?;
    let update = SessionUiStateUpdate {
        pinned: patch.pinned,
        title_override: patch.title.map(Some),
        ..Default::default()
    };
    let updated = storage::update_session_ui_state(
        &transaction,
        &entry.session_path,
        &update,
        Some(&entry.project_id),
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    session_api::publish_sessions_indexed(runtime, entry.project_id.clone());
    Ok(updated)
}

async fn start(
    runtime: &Runtime,
    project: String,
    key: String,
    path: Option<String>,
) -> Result<crate::session_snapshot::PiSessionSnapshot, String> {
    runtime_api::chat_session_start(runtime, project, key, path, false, None, None).await
}

async fn send(runtime: &Runtime, key: &str, message: String) -> Result<Value, PiCommandError> {
    let _policy = runtime.pi_resource_policy.read().await;
    let response = call(
        runtime,
        key,
        json!({"type": "prompt", "message": message}),
        true,
    )
    .await?;
    // Pi can start persisting a draft only after accepting its first prompt.
    // Request the new file identity even when no desktop chat pane is observing it.
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        call(runtime, key, json!({"type": "get_state"}), false),
    )
    .await;
    Ok(response["disposition"].clone())
}

async fn call(
    runtime: &Runtime,
    key: &str,
    mut command: Value,
    require_idle: bool,
) -> Result<Value, PiCommandError> {
    let id = format!("pilo-ctl-{}", SEQUENCE.fetch_add(1, Ordering::Relaxed));
    command["id"] = json!(id);
    let mut events = runtime.events.subscribe_events(EventQueueLimits {
        max_events: 256,
        max_bytes: 2 * 1024 * 1024,
    });
    let write = if require_idle {
        runtime
            .chat_sessions
            .send_when_idle(&runtime.paths, key, command)
            .await
    } else {
        runtime
            .chat_sessions
            .send(&runtime.paths, key, command)
            .await
            .map_err(PiCommandError::OutcomeUnknown)
    };
    write.map_err(|error| match error {
        PiCommandError::OutcomeUnknown(message) => unknown_outcome(&message),
        error => error,
    })?;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let EventBatch::Events(batch) = events.next_batch(64).await else {
                return Err(unknown_outcome("Pi response stream was interrupted"));
            };
            for event in batch {
                if event.event.session_key.as_deref() != Some(key) {
                    continue;
                }
                match &event.event.event {
                    RuntimeEvent::RpcMessage { message, .. }
                        if message["type"] == "response"
                            && message["id"].as_str() == Some(id.as_str()) =>
                    {
                        return match message["success"].as_bool() {
                            Some(true) => Ok(message["data"].clone()),
                            Some(false) => Err(PiCommandError::NotAccepted(
                                message["error"]
                                    .as_str()
                                    .unwrap_or("Pi rejected the command")
                                    .to_owned(),
                            )),
                            None => Err(unknown_outcome("Pi returned an invalid response")),
                        };
                    }
                    RuntimeEvent::ProcessState {
                        state: PiProcessState::Stopped | PiProcessState::Failed,
                        ..
                    } => {
                        return Err(unknown_outcome("Pi stopped before replying"));
                    }
                    _ => {}
                }
            }
        }
    })
    .await
    .map_err(|_| unknown_outcome("Pi response timed out"))?
}

fn unknown_outcome(message: &str) -> PiCommandError {
    PiCommandError::OutcomeUnknown(format!(
        "{message}; outcome is unknown; do not retry automatically"
    ))
}
