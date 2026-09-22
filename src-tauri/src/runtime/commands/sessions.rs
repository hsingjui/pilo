use std::{
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

use crate::domain::{SessionIndexEntry, SessionReconcileResult, SessionUiStateUpdate};
use serde::{Deserialize, Serialize};

use super::super::{
    PiloRuntime,
    events::{PiProcessState, RuntimeEvent, RuntimeEventSink},
    pi_workspace, project,
    server_pi::{PiLaunchOptions, ServerPiSession},
    session_history, session_index, storage,
};

const SESSION_NAMING_SYSTEM_PROMPT: &str = "Generate a concise title for a coding conversation from the user's first message. Return exactly one plain-text title with no quotes, markdown, explanation, prefix, or suffix. Use the same language as the user. Prefer at most 24 CJK characters or 60 Latin characters.";

fn session_runtime_project(
    app: &AppHandle,
    project_id: &str,
) -> Result<crate::domain::Project, String> {
    let project = project::get(app, project_id)?;
    pi_workspace::resolve_session_project(app, &project)
}

#[derive(Clone)]
struct SessionNamingEventSink {
    sender: mpsc::UnboundedSender<RuntimeEvent>,
}

impl RuntimeEventSink for SessionNamingEventSink {
    fn send(&self, event: RuntimeEvent) {
        let _ = self.sender.send(event);
    }
}

fn normalize_generated_session_title(value: &str) -> Option<String> {
    let line = value.lines().map(str::trim).find(|line| !line.is_empty())?;
    let trimmed = line
        .trim_matches(|ch: char| matches!(ch, '"' | '\'' | '`' | '*' | '#'))
        .trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut title = trimmed.chars().take(80).collect::<String>();
    if trimmed.chars().count() > 80 {
        title.push('…');
    }
    Some(title)
}

#[tauri::command]
pub async fn session_generate_title(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    message: String,
) -> Result<Option<String>, String> {
    let message = message.trim();
    if message.is_empty() {
        return Ok(None);
    }

    let project = project::get(&app, &project_id)?;
    let naming_model =
        storage::get_connection_naming_model(&storage::open(&app)?, &project.connection.id)?;
    let Some(naming_model) = naming_model else {
        return Ok(None);
    };

    let (sender, mut receiver) = mpsc::unbounded_channel();
    let mut session = ServerPiSession::default();
    let runtime_project = pi_workspace::resolve_session_project(&app, &project)?;
    session
        .spawn(
            Arc::clone(&runtime.servers),
            SessionNamingEventSink { sender },
            &runtime_project,
            PiLaunchOptions {
                no_session: true,
                disable_resources: true,
                provider: Some(naming_model.provider),
                model: Some(naming_model.model_id),
                thinking: Some("off".to_owned()),
                system_prompt: Some(SESSION_NAMING_SYSTEM_PROMPT.to_owned()),
                ..PiLaunchOptions::default()
            },
        )
        .await?;

    let result = async {
        session
            .send_rpc(serde_json::json!({ "type": "prompt", "message": message }))
            .await?;
        let mut latest_text = String::new();
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                let event = receiver
                    .recv()
                    .await
                    .ok_or_else(|| "Pi naming event stream closed".to_owned())?;
                match event {
                    RuntimeEvent::AssistantTextSnapshot { text, .. } => latest_text = text,
                    RuntimeEvent::AssistantMessageEnd {
                        stop_reason,
                        error_message,
                        ..
                    } => {
                        if stop_reason.as_deref() == Some("error")
                            || error_message
                                .as_deref()
                                .is_some_and(|value| !value.trim().is_empty())
                        {
                            return Err(error_message.unwrap_or_else(|| {
                                "Pi failed to generate a session title".to_owned()
                            }));
                        }
                        return Ok(normalize_generated_session_title(&latest_text));
                    }
                    RuntimeEvent::RuntimeError { message, .. } => return Err(message),
                    RuntimeEvent::ProcessState {
                        state: PiProcessState::Failed | PiProcessState::Stopped,
                        ..
                    } => {
                        return Err("Pi naming process stopped before producing a title".to_owned());
                    }
                    _ => {}
                }
            }
        })
        .await
        .map_err(|_| "Pi session title generation timed out".to_owned())?
    }
    .await;

    let stop_result = session.stop().await;
    match (result, stop_result) {
        (Ok(title), _) => Ok(title),
        (Err(error), _) => Err(error),
    }
}

struct BackgroundSessionIndexLease {
    manager: Arc<StdMutex<session_index::BackgroundSessionIndexManager>>,
    project_id: String,
    armed: bool,
}

impl BackgroundSessionIndexLease {
    fn new(
        manager: Arc<StdMutex<session_index::BackgroundSessionIndexManager>>,
        project_id: String,
    ) -> Self {
        Self {
            manager,
            project_id,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for BackgroundSessionIndexLease {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut manager = self
            .manager
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        manager.worker_aborted(&self.project_id);
    }
}

#[tauri::command]
pub fn session_list(app: AppHandle, project_id: String) -> Result<Vec<SessionIndexEntry>, String> {
    session_index::list_cached(&app, &project_id)
}

#[tauri::command]
pub async fn session_reconcile(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
) -> Result<SessionReconcileResult, String> {
    let project = project::get(&app, &project_id)?;
    let work = session_index::reconcile(&app, &runtime.servers, &project).await?;
    if !work.deferred_paths.is_empty() {
        let should_start_background_index = {
            let mut manager = runtime
                .background_session_index
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            manager.enqueue(&project.id, work.deferred_paths)
        };
        if should_start_background_index {
            let background_app = app.clone();
            let background_servers = Arc::clone(&runtime.servers);
            let background_manager = Arc::clone(&runtime.background_session_index);
            let background_project = project.clone();
            tokio::spawn(async move {
                let mut lease = BackgroundSessionIndexLease::new(
                    Arc::clone(&background_manager),
                    background_project.id.clone(),
                );
                let mut indexed_total = 0_usize;
                let mut failure = None;
                loop {
                    let batch = {
                        let mut manager = background_manager
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        manager.next_batch_or_finish(
                            &background_project.id,
                            session_index::BACKGROUND_SESSION_INDEX_BATCH,
                        )
                    };
                    let Some(batch) = batch else {
                        lease.disarm();
                        break;
                    };
                    let paths = batch
                        .iter()
                        .map(|(path, _)| path.clone())
                        .collect::<Vec<_>>();
                    match session_index::index_paths(
                        &background_app,
                        &background_servers,
                        &background_project,
                        &paths,
                    )
                    .await
                    {
                        Ok(indexed) => {
                            indexed_total += indexed;
                            background_manager
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .complete_batch(&background_project.id, &batch);
                        }
                        Err(error) => {
                            failure = Some(error);
                            break;
                        }
                    }
                    tokio::task::yield_now().await;
                }
                if indexed_total > 0 {
                    let _ = background_app.emit(
                        "pilo://sessions",
                        serde_json::json!({
                            "type": "indexed",
                            "projectId": background_project.id,
                        }),
                    );
                }
                if let Some(error) = failure {
                    let _ = background_app.emit(
                        "pilo://sessions",
                        serde_json::json!({
                            "type": "error",
                            "projectId": background_project.id,
                            "message": format!("background session indexing failed: {error}"),
                        }),
                    );
                }
            });
        }
    }
    Ok(work.result)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExternalActivity {
    pub path: String,
    pub turn_open: bool,
}

pub(crate) async fn external_session_activities_for_project(
    runtime: &PiloRuntime,
    project: &crate::domain::Project,
) -> Result<Vec<SessionExternalActivity>, String> {
    let owned_session_paths = runtime
        .chat_sessions
        .states()
        .await
        .into_iter()
        .filter(|state| state.project_id == project.id)
        .filter_map(|state| state.session_path)
        .collect::<Vec<_>>();
    runtime
        .servers
        .request_typed(
            &project.connection,
            "session.activity",
            serde_json::json!({
                "project": project.path,
                "ownedSessionPaths": owned_session_paths,
            }),
        )
        .await
}

#[tauri::command]
pub async fn session_external_activity(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
) -> Result<Vec<SessionExternalActivity>, String> {
    let project = session_runtime_project(&app, &project_id)?;
    external_session_activities_for_project(&runtime, &project).await
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchMatch {
    pub session_path: String,
    pub session_id: String,
    pub role: String,
    pub snippet: String,
    pub timestamp: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn session_search(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SessionSearchMatch>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let project = session_runtime_project(&app, &project_id)?;
    runtime
        .servers
        .request_typed(
            &project.connection,
            "session.search",
            serde_json::json!({
                "project": project.path,
                "query": query,
                "limit": limit.unwrap_or(24),
            }),
        )
        .await
}

#[tauri::command]
// Tauri commands expose their arguments flat; the window options are part of the command surface.
#[allow(clippy::too_many_arguments)]
pub async fn session_history(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    session_path: String,
    expected_file_size: Option<u64>,
    expected_file_mtime_ns: Option<String>,
    start_message: Option<usize>,
    message_limit: Option<usize>,
    include_message_index: Option<bool>,
) -> Result<tauri::ipc::Response, String> {
    let project = session_runtime_project(&app, &project_id)?;
    let expected_fingerprint =
        expected_session_fingerprint(expected_file_size, expected_file_mtime_ns)?;
    let serialized = if let Some(message_limit) = message_limit {
        session_history::read_history_window_json(
            &runtime.servers,
            &runtime.session_history_cache,
            &project,
            &session_path,
            expected_fingerprint,
            start_message,
            message_limit,
            include_message_index.unwrap_or(false),
        )
        .await?
    } else {
        session_history::read_history_json(
            &runtime.servers,
            &runtime.session_history_cache,
            &project,
            &session_path,
            expected_fingerprint,
        )
        .await?
    };
    Ok(tauri::ipc::Response::new(serialized))
}

fn expected_session_fingerprint(
    expected_file_size: Option<u64>,
    expected_file_mtime_ns: Option<String>,
) -> Result<Option<(u64, u64)>, String> {
    let expected_file_mtime_ns = expected_file_mtime_ns
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|error| format!("invalid expected session mtime '{value}': {error}"))
        })
        .transpose()?;
    Ok(expected_file_size.zip(expected_file_mtime_ns))
}

/// Returns the raw image bytes for `{entryId}:{contentIndex}` ids emitted on
/// `user_message_start.images`; the mime type is already known to the caller.
#[tauri::command]
pub async fn session_history_image(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    session_path: String,
    image_id: String,
    expected_file_size: Option<u64>,
    expected_file_mtime_ns: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let project = session_runtime_project(&app, &project_id)?;
    let expected_fingerprint =
        expected_session_fingerprint(expected_file_size, expected_file_mtime_ns)?;
    let bytes = session_history::read_history_image_bytes(
        &runtime.servers,
        &runtime.session_history_cache,
        &project,
        &session_path,
        &image_id,
        expected_fingerprint,
    )
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn session_watch_start(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
) -> Result<(), String> {
    let project = project::get(&app, &project_id)?;
    runtime
        .session_watchers
        .lock()
        .await
        .start(Arc::clone(&runtime.servers), app, project)
        .await
}

#[tauri::command]
pub async fn session_watch_stop(
    runtime: State<'_, PiloRuntime>,
    project_id: String,
) -> Result<(), String> {
    runtime
        .session_watchers
        .lock()
        .await
        .stop(&project_id)
        .await;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleteResult {
    method: String,
}

#[tauri::command]
pub async fn session_delete(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    session_path: String,
) -> Result<SessionDeleteResult, String> {
    let project = session_runtime_project(&app, &project_id)?;
    let db = storage::open(&app)?;
    let indexed = storage::get_session(&db, &session_path)?
        .ok_or_else(|| format!("session '{session_path}' is not indexed"))?;
    if indexed.project_id != project.id {
        return Err("session belongs to a different project".to_owned());
    }

    let value = runtime
        .servers
        .request(
            &project.connection,
            "session.delete",
            serde_json::json!({ "path": session_path }),
        )
        .await?;
    let method = value
        .get("method")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unlink")
        .to_owned();
    storage::remove_session_for_project(&db, &project.id, &indexed.session_path)?;
    runtime
        .session_history_cache
        .lock()
        .await
        .invalidate(&project, &indexed.session_path);
    Ok(SessionDeleteResult { method })
}

#[tauri::command]
pub fn session_update_ui_state(
    app: AppHandle,
    session_path: String,
    update: SessionUiStateUpdate,
) -> Result<SessionIndexEntry, String> {
    storage::update_session_ui_state(&storage::open(&app)?, &session_path, &update)
}
