//! Session operations for scripted callers (the `pilo` CLI over local IPC).
//!
//! Sessions are addressed by project plus Pi session ID or runtime session key,
//! never by a JSONL path. Writes report explicit rejections (`conflict`) apart
//! from results that may or may not have taken effect (`outcome_unknown`).

use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use pilo_domain::{ConnectionKind, SessionIndexEntry, SessionUiStateUpdate};
use serde_json::{Value, json};

use crate::{
    Runtime, TranscriptWindow,
    chat_sessions::{ChatSessionState, PiCommandError, same_session_file},
    events::{
        EventBatch, EventQueueLimits, PiProcessState, RuntimeEvent, turn_projection::TurnLive,
    },
    host_api::{ErrorCode, HostApiError},
    project, runtime_api, session_api, storage,
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const DEFAULT_PAGE: usize = 50;
const MAX_PAGE: usize = 100;
/// Tail of the transcript searched for the last assistant message.
const STATUS_MESSAGE_WINDOW: usize = 32;

/// A session resolved inside one project.
pub(crate) struct Target {
    pub key: String,
    pub entry: Option<SessionIndexEntry>,
    pub state: Option<ChatSessionState>,
}

impl Target {
    pub fn session_id(&self) -> String {
        self.entry
            .as_ref()
            .map(|entry| entry.pi_session_id.clone())
            .unwrap_or_else(|| self.key.clone())
    }

    fn path(&self) -> Option<&str> {
        self.entry
            .as_ref()
            .map(|entry| entry.session_path.as_str())
            .or_else(|| self.state.as_ref()?.session_path.as_deref())
    }

    fn saved(&self) -> Result<&SessionIndexEntry, HostApiError> {
        self.entry
            .as_ref()
            .ok_or_else(|| conflict("session is not indexed yet"))
    }
}

fn conflict(message: impl Into<String>) -> HostApiError {
    HostApiError::new(ErrorCode::Conflict, message)
}

fn command_error(error: PiCommandError) -> HostApiError {
    match error {
        PiCommandError::NotAccepted(message) => conflict(message),
        PiCommandError::OutcomeUnknown(message) => {
            HostApiError::new(ErrorCode::OutcomeUnknown, message)
        }
    }
}

async fn runtime_states(runtime: &Runtime, project: &str) -> Vec<ChatSessionState> {
    runtime
        .chat_sessions
        .persistent_states()
        .await
        .into_iter()
        .filter(|state| state.project_id == project && !is_fork_helper(state))
        .collect()
}

fn require_project(runtime: &Runtime, project: &str) -> Result<(), HostApiError> {
    project::get(runtime, project)
        .map(|_| ())
        .map_err(HostApiError::not_found)
}

pub(crate) async fn resolve(
    runtime: &Runtime,
    project: &str,
    id: &str,
) -> Result<Target, HostApiError> {
    require_project(runtime, project)?;
    if id.trim().is_empty() {
        return Err(HostApiError::invalid("session ID is required"));
    }
    let states = runtime_states(runtime, project).await;
    let entries = blocking(runtime, {
        let project = project.to_owned();
        move |runtime| session_api::session_list(runtime, project)
    })
    .await?;
    let short_key = chat_key(project, id);
    let input_state = states
        .iter()
        .find(|state| state.session_key == id || state.session_key == short_key);
    let entry = if let Some(state) = input_state.filter(|state| state.session_path.is_some()) {
        entries
            .iter()
            .find(|entry| owns_file(state, &entry.session_path))
    } else {
        entries.iter().find(|entry| {
            entry.pi_session_id == id || chat_key(project, &entry.pi_session_id) == id
        })
    };
    let state = input_state.or_else(|| {
        entry.and_then(|entry| {
            let canonical_key = chat_key(project, &entry.pi_session_id);
            states.iter().find(|state| {
                owns_file(state, &entry.session_path)
                    || (state.session_path.is_none() && state.session_key == canonical_key)
            })
        })
    });
    let key = state
        .map(|state| state.session_key.clone())
        .or_else(|| entry.map(|entry| chat_key(project, &entry.pi_session_id)))
        .ok_or_else(|| HostApiError::not_found("session not found in the specified project"))?;
    Ok(Target {
        key,
        entry: entry.cloned(),
        state: state.cloned(),
    })
}

pub(crate) async fn get(runtime: &Runtime, project: &str, id: &str) -> Result<Value, HostApiError> {
    let target = resolve(runtime, project, id).await?;
    Ok(json!({
        "sessionId": target.session_id(),
        "sessionKey": target.key,
        "saved": target.entry,
        "runtime": target.state,
    }))
}

pub(crate) async fn page(
    runtime: &Runtime,
    project: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Value, HostApiError> {
    require_project(runtime, project)?;
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
    let entries = session_api::session_refresh_unwatched(runtime, project.to_owned())
        .await
        .map_err(HostApiError::internal)?;
    let total = entries.len();
    let next = offset.saturating_add(limit);
    let saved: Vec<_> = entries.into_iter().skip(offset).take(limit).collect();
    Ok(json!({
        "saved": saved,
        "runtime": runtime_states(runtime, project).await,
        "total": total,
        "nextOffset": (next < total).then_some(next),
    }))
}

/// Reads a bounded page of the saved transcript without starting Pi.
pub(crate) async fn history(
    runtime: &Runtime,
    target: &Target,
    project: &str,
    start_message: Option<usize>,
    message_limit: Option<usize>,
) -> Result<Vec<u8>, HostApiError> {
    let path = target
        .path()
        .ok_or_else(|| conflict("the session has not been saved yet"))?;
    session_api::read_session_history(
        runtime,
        project.to_owned(),
        path.to_owned(),
        None,
        None,
        start_message,
        Some(message_limit.unwrap_or(24).clamp(1, MAX_PAGE)),
        None,
    )
    .await
}

/// Starts a new session and returns once Pi accepted its first prompt.
pub(crate) async fn create(
    runtime: &Runtime,
    project: String,
    session_id: String,
    message: String,
    title: Option<String>,
) -> Result<Value, HostApiError> {
    require_project(runtime, &project)?;
    validate_message(&message)?;
    if let Some(title) = &title {
        validate_title(title)?;
    }
    validate_new_session_id(&session_id)?;
    let key = chat_key(&project, &session_id);
    if runtime.chat_sessions.state(&key).await.is_some()
        || resolve(runtime, &project, &session_id).await.is_ok()
    {
        return Err(conflict("session ID is already in use; generate a new one"));
    }
    start(runtime, project.clone(), key.clone(), None)
        .await
        .map_err(|error| HostApiError::invalid(format!("{error}; first message was not sent")))?;
    if let Err(error) = session_api::session_watch_start(runtime, project).await {
        log::warn!("failed to watch the project of a CLI-created session: {error}");
    }
    let result = async {
        if let Some(title) = title {
            let _policy = runtime.pi_resource_policy.read().await;
            call(
                runtime,
                &key,
                json!({"type": "set_session_name", "name": title}),
                false,
            )
            .await
            .map_err(|error| match error {
                PiCommandError::NotAccepted(message) => PiCommandError::NotAccepted(format!(
                    "could not set the session title: {message}; first message was not sent"
                )),
                error => error,
            })?;
        }
        send_prompt(runtime, &key, message).await
    }
    .await;
    let disposition = match result {
        Ok(disposition) => disposition,
        // Pi explicitly refused: reclaim the process this call started.
        Err(PiCommandError::NotAccepted(message)) => {
            if let Err(stop_error) = runtime
                .chat_sessions
                .stop(&key, Some("cli_create_failed"))
                .await
            {
                return Err(HostApiError::new(
                    ErrorCode::OutcomeUnknown,
                    format!("session {key}: {message}; could not confirm Pi stopped: {stop_error}"),
                ));
            }
            return Err(conflict(message));
        }
        // Unknown outcome: keep the session so the caller can query it by key.
        Err(error @ PiCommandError::OutcomeUnknown(_)) => {
            let error = command_error(error);
            return Err(HostApiError::new(
                error.code,
                format!("session {key}: {}", error.message),
            ));
        }
    };
    let state = runtime.chat_sessions.state(&key).await;
    Ok(json!({
        "sessionId": session_id,
        "sessionKey": key,
        "accepted": true,
        "disposition": disposition,
        "runtime": state,
    }))
}

/// Sends a prompt to an idle session, resuming a saved one; busy targets are refused.
pub(crate) async fn send(
    runtime: &Runtime,
    project: &str,
    id: &str,
    message: String,
) -> Result<Value, HostApiError> {
    validate_message(&message)?;
    let target = resolve(runtime, project, id).await?;
    let running = target
        .state
        .as_ref()
        .is_some_and(|state| state.initialized && state.snapshot.state == PiProcessState::Running);
    if !running {
        let path = target
            .path()
            .ok_or_else(|| conflict("the session has not been saved yet"))?;
        start(
            runtime,
            project.to_owned(),
            target.key.clone(),
            Some(path.to_owned()),
        )
        .await
        .map_err(HostApiError::invalid)?;
    }
    let disposition = send_prompt(runtime, &target.key, message)
        .await
        .map_err(command_error)?;
    Ok(json!({"sessionKey": target.key, "accepted": true, "disposition": disposition}))
}

/// Interrupts the current turn; the managed Pi process keeps running.
pub(crate) async fn abort(
    runtime: &Runtime,
    project: &str,
    id: &str,
) -> Result<Value, HostApiError> {
    let target = resolve(runtime, project, id).await?;
    target
        .state
        .as_ref()
        .filter(|state| state.snapshot.state == PiProcessState::Running)
        .ok_or_else(|| conflict("session is not running"))?;
    let _policy = runtime.pi_resource_policy.read().await;
    call(runtime, &target.key, json!({"type": "abort"}), false)
        .await
        .map_err(command_error)?;
    Ok(json!({"sessionKey": target.key, "abortRequested": true}))
}

/// Closes the managed Pi process and keeps the saved history.
pub(crate) async fn stop(
    runtime: &Runtime,
    project: &str,
    id: &str,
) -> Result<Value, HostApiError> {
    let target = resolve(runtime, project, id).await?;
    let was_running = target.state.is_some();
    if was_running {
        runtime_api::chat_session_stop(runtime, target.key.clone(), Some("cli".to_owned()))
            .await
            .map_err(HostApiError::internal)?;
    }
    Ok(json!({"sessionKey": target.key, "stopped": true, "wasRunning": was_running}))
}

pub(crate) async fn update(
    runtime: &Runtime,
    project: &str,
    id: &str,
    title: Option<String>,
    pinned: Option<bool>,
) -> Result<SessionIndexEntry, HostApiError> {
    if let Some(title) = &title {
        validate_title(title)?;
    } else if pinned.is_none() {
        return Err(HostApiError::invalid(
            "session update requires title or pinned",
        ));
    }
    let entry = resolve(runtime, project, id).await?.saved()?.clone();
    let update = SessionUiStateUpdate {
        pinned,
        title_override: title.map(Some),
        ..Default::default()
    };
    set_ui_state(runtime, entry, update).await
}

async fn set_ui_state(
    runtime: &Runtime,
    entry: SessionIndexEntry,
    update: SessionUiStateUpdate,
) -> Result<SessionIndexEntry, HostApiError> {
    let project = entry.project_id.clone();
    let updated = blocking(runtime, move |runtime| {
        let mut db = storage::open(&runtime.paths)?;
        let transaction = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        storage::get_session(&transaction, &entry.session_path, Some(&entry.project_id))?
            .ok_or("session is no longer indexed")?;
        let updated = storage::update_session_ui_state(
            &transaction,
            &entry.session_path,
            &update,
            Some(&entry.project_id),
        )?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(updated)
    })
    .await?;
    session_api::publish_sessions_indexed(runtime, project);
    Ok(updated)
}

/// Moves the saved session to the trash through the connection's safe path.
/// A session still owned by a managed Pi process is refused, not stopped.
pub(crate) async fn trash(
    runtime: &Runtime,
    project: &str,
    id: &str,
) -> Result<Value, HostApiError> {
    let target = resolve(runtime, project, id).await?;
    let entry = target.saved()?;
    let result = session_api::remove_saved_session(
        runtime,
        project.to_owned(),
        entry.session_path.clone(),
        true,
    )
    .await
    .map_err(conflict)?;
    Ok(json!({"sessionKey": target.key, "deleted": true, "result": result}))
}

/// A one-shot status read. It never starts Pi or subscribes to events.
pub(crate) async fn status(
    runtime: &Runtime,
    project: &str,
    id: &str,
) -> Result<Value, HostApiError> {
    let target = resolve(runtime, project, id).await?;
    let session_id = target.session_id();
    let process = target.state.as_ref().map(|state| state.snapshot.state);
    let state = match (&target.state, process) {
        (None, _) | (_, Some(PiProcessState::Stopped | PiProcessState::Stopping)) => "not_running",
        (_, Some(PiProcessState::Failed)) => "error",
        (Some(state), _) if state.compacting => "compacting",
        (Some(state), _) if state.active_turn || process == Some(PiProcessState::Starting) => {
            "running"
        }
        _ => "idle",
    };
    let mut turn = Value::Null;
    let mut running_tools = Value::Null;
    let mut last_assistant = None;
    if matches!(state, "running" | "compacting" | "idle")
        && let Ok(snapshot) = runtime
            .chat_transcript_snapshot(
                &target.key,
                TranscriptWindow {
                    start_message: None,
                    message_limit: Some(STATUS_MESSAGE_WINDOW),
                    include_message_index: false,
                },
            )
            .await
    {
        (turn, running_tools) = match &snapshot.live {
            TurnLive::Idle => (json!("idle"), json!([])),
            TurnLive::Active { events } => (json!("active"), json!(running_tool_names(events))),
            TurnLive::Truncated => (json!("truncated"), Value::Null),
        };
        last_assistant = last_assistant_message(&snapshot.history);
    }
    if last_assistant.is_none()
        && target.path().is_some()
        && let Ok(bytes) =
            history(runtime, &target, project, None, Some(STATUS_MESSAGE_WINDOW)).await
        && let Ok(history) = serde_json::from_slice::<Value>(&bytes)
    {
        last_assistant = last_assistant_message(&history);
    }
    Ok(json!({
        "sessionId": session_id,
        "state": state,
        "turn": turn,
        "runningTools": running_tools,
        "lastAssistantMessage": last_assistant,
    }))
}

fn running_tool_names(events: &[std::sync::Arc<RuntimeEvent>]) -> Vec<String> {
    let mut started: Vec<(String, String)> = Vec::new();
    let mut ended: HashMap<String, ()> = HashMap::new();
    for event in events {
        match event.as_ref() {
            RuntimeEvent::ToolExecutionStart {
                tool_call_id,
                tool_name,
                ..
            } => started.push((tool_call_id.clone(), tool_name.clone())),
            RuntimeEvent::ToolExecutionEnd { tool_call_id, .. } => {
                ended.insert(tool_call_id.clone(), ());
            }
            _ => {}
        }
    }
    started
        .into_iter()
        .filter(|(id, _)| !ended.contains_key(id))
        .map(|(_, name)| name)
        .collect()
}

/// The text of the last assistant message in a history window or transcript cut.
fn last_assistant_message(history: &Value) -> Option<String> {
    let events = history
        .get("events")
        .or_else(|| history.get("history")?.get("events"))?
        .as_array()?;
    let mut last = None;
    let mut current: Option<String> = None;
    let mut commit = |current: &mut Option<String>| {
        if let Some(text) = current.take().filter(|text| !text.trim().is_empty()) {
            last = Some(text);
        }
    };
    for event in events {
        match event.get("type").and_then(Value::as_str) {
            Some("assistant_message_start") => {
                commit(&mut current);
                current = Some(String::new());
            }
            Some("assistant_text_delta") => {
                if let (Some(text), Some(delta)) =
                    (current.as_mut(), event.get("delta").and_then(Value::as_str))
                {
                    text.push_str(delta);
                }
            }
            Some("user_message_start") => commit(&mut current),
            _ => {}
        }
    }
    commit(&mut current);
    last
}

const NEW_SESSION_ID_PREFIX: &str = "cli-";

fn validate_new_session_id(id: &str) -> Result<(), HostApiError> {
    let hex = id.strip_prefix(NEW_SESSION_ID_PREFIX).unwrap_or_default();
    if hex.len() == 32
        && hex
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(HostApiError::invalid(
            "sessionId must be 'cli-' followed by 32 lowercase hex digits",
        ))
    }
}

fn chat_key(project: &str, id: &str) -> String {
    json!([project, id]).to_string()
}

pub(crate) fn owns_file(state: &ChatSessionState, path: &str) -> bool {
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

pub(crate) fn validate_message(message: &str) -> Result<(), HostApiError> {
    let text = message.trim();
    if text.is_empty() || text.starts_with('/') || message.len() > MAX_MESSAGE_BYTES {
        return Err(HostApiError::invalid(
            "message must be non-empty plain text (no slash commands; up to 64 KiB)",
        ));
    }
    Ok(())
}

pub(crate) fn validate_title(title: &str) -> Result<(), HostApiError> {
    if title.trim().is_empty() || title.len() > 512 || title.chars().any(char::is_control) {
        return Err(HostApiError::invalid(
            "title must be non-empty single-line text (up to 512 bytes)",
        ));
    }
    Ok(())
}

async fn blocking<T: Send + 'static>(
    runtime: &Runtime,
    operation: impl FnOnce(&Runtime) -> Result<T, String> + Send + 'static,
) -> Result<T, HostApiError> {
    let runtime = runtime.clone();
    tokio::task::spawn_blocking(move || operation(&runtime))
        .await
        .map_err(|error| HostApiError::internal(error.to_string()))?
        .map_err(HostApiError::internal)
}

async fn start(
    runtime: &Runtime,
    project: String,
    key: String,
    path: Option<String>,
) -> Result<crate::session_snapshot::PiSessionSnapshot, String> {
    runtime_api::chat_session_start(runtime, project, key, path, false, None, None).await
}

async fn send_prompt(
    runtime: &Runtime,
    key: &str,
    message: String,
) -> Result<Value, PiCommandError> {
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

/// Sends one Pi RPC command and waits for its correlated response.
async fn call(
    runtime: &Runtime,
    key: &str,
    mut command: Value,
    require_idle: bool,
) -> Result<Value, PiCommandError> {
    let id = format!("pilo-cli-{}", SEQUENCE.fetch_add(1, Ordering::Relaxed));
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn last_assistant_message_skips_empty_and_tool_only_messages() {
        let history = json!({"events": [
            {"type": "user_message_start", "text": "hi"},
            {"type": "assistant_message_start"},
            {"type": "assistant_text_delta", "delta": "Hel"},
            {"type": "assistant_text_delta", "delta": "lo"},
            {"type": "assistant_message_start"},
            {"type": "tool_execution_start"},
        ]});
        assert_eq!(last_assistant_message(&history).as_deref(), Some("Hello"));
        let wrapped = json!({"history": history});
        assert_eq!(last_assistant_message(&wrapped).as_deref(), Some("Hello"));
        assert_eq!(last_assistant_message(&json!({"events": []})), None);
    }

    #[test]
    fn running_tools_are_started_but_not_ended() {
        let event = |end: bool, id: &str, name: &str| {
            std::sync::Arc::new(if end {
                RuntimeEvent::ToolExecutionEnd {
                    generation: 1,
                    tool_call_id: id.into(),
                    tool_name: name.into(),
                    result: Value::Null,
                    is_error: false,
                }
            } else {
                RuntimeEvent::ToolExecutionStart {
                    generation: 1,
                    tool_call_id: id.into(),
                    tool_name: name.into(),
                    args: Value::Null,
                }
            })
        };
        let events = [
            event(false, "a", "bash"),
            event(false, "b", "read"),
            event(true, "a", "bash"),
        ];
        assert_eq!(running_tool_names(&events), ["read"]);
    }

    #[test]
    fn messages_and_titles_are_validated() {
        for message in ["", "   ", "/compact", " /model x"] {
            assert!(validate_message(message).is_err(), "{message:?}");
        }
        assert!(validate_message(&"x".repeat(MAX_MESSAGE_BYTES + 1)).is_err());
        assert!(validate_message("fix the bug").is_ok());
        assert!(validate_title("a\nb").is_err());
        assert!(validate_title(" ").is_err());
        assert!(validate_title("Release notes").is_ok());
    }
}
