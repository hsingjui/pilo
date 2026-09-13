use std::sync::{Arc, Mutex as StdMutex};

use tauri::{AppHandle, Emitter, State};

use crate::domain::{SessionIndexEntry, SessionReconcileResult, SessionUiStateUpdate};
use serde::Serialize;

use super::super::{PiloRuntime, project, session_history, session_index, storage};

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

#[tauri::command]
pub async fn session_history(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    session_path: String,
    expected_file_size: Option<u64>,
    expected_file_mtime_ns: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let project = project::get(&app, &project_id)?;
    let expected_file_mtime_ns = expected_file_mtime_ns
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|error| format!("invalid expected session mtime '{value}': {error}"))
        })
        .transpose()?;
    let serialized = session_history::read_history_json(
        &runtime.servers,
        &runtime.session_history_cache,
        &project,
        &session_path,
        expected_file_size.zip(expected_file_mtime_ns),
    )
    .await?;
    Ok(tauri::ipc::Response::new(serialized))
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
    let project = project::get(&app, &project_id)?;
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
