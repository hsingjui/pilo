use std::sync::{Arc, Mutex as StdMutex};

use tauri::{AppHandle, Manager, State};

use super::super::session_api::SessionDeleteResult;
use crate::domain::{SessionIndexEntry, SessionReconcileResult, SessionUiStateUpdate};

use super::super::{
    PiloRuntime, Runtime,
    events::{RuntimeEvent, RuntimeEventBus, RuntimeEventEnvelope},
    pi_workspace, project, session_index,
};

mod history;
mod naming;

pub use history::{
    session_external_activity, session_history, session_history_image, session_search,
};
pub use naming::session_generate_title;

fn session_runtime_project(
    app: &AppHandle,
    project_id: &str,
) -> Result<crate::domain::Project, String> {
    let project = project::get(&app.state::<crate::runtime::Runtime>(), project_id)?;
    pi_workspace::resolve_session_project(app, &project)
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
pub fn session_list(
    runtime: State<'_, Runtime>,
    project_id: String,
) -> Result<Vec<SessionIndexEntry>, String> {
    super::super::session_api::session_list(&runtime, project_id)
}

#[tauri::command]
pub async fn session_reconcile(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
) -> Result<SessionReconcileResult, String> {
    let project = project::get(&app.state::<crate::runtime::Runtime>(), &project_id)?;
    let host_paths = crate::desktop_paths::from_app(&app)?;
    let work = session_index::reconcile(&host_paths, &runtime.servers, &project).await?;
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
            let host_events = crate::desktop_events::from_app(&app);
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
                        &host_paths,
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
                    let _ = host_events.emit_serialized(
                        "pilo://sessions",
                        serde_json::json!({
                            "type": "indexed",
                            "projectId": background_project.id,
                        }),
                    );
                    background_app
                        .state::<RuntimeEventBus>()
                        .send(RuntimeEventEnvelope::global(
                            RuntimeEvent::SessionsIndexed {
                                project_id: background_project.id.clone(),
                            },
                        ));
                }
                if let Some(error) = failure {
                    let message = format!("background session indexing failed: {error}");
                    background_app
                        .state::<RuntimeEventBus>()
                        .send(RuntimeEventEnvelope::global(
                            RuntimeEvent::SessionIndexError {
                                project_id: background_project.id.clone(),
                                message: message.clone(),
                            },
                        ));
                    let _ = host_events.emit_serialized(
                        "pilo://sessions",
                        serde_json::json!({
                            "type": "error",
                            "projectId": background_project.id,
                            "message": message,
                        }),
                    );
                }
            });
        }
    }
    Ok(work.result)
}

#[tauri::command]
pub async fn session_watch_start(
    runtime: State<'_, Runtime>,
    project_id: String,
) -> Result<(), String> {
    super::super::session_api::session_watch_start(&runtime, project_id).await
}

#[tauri::command]
pub async fn session_watch_stop(
    runtime: State<'_, Runtime>,
    project_id: String,
) -> Result<(), String> {
    super::super::session_api::session_watch_stop(&runtime, project_id).await
}

#[tauri::command]
pub async fn session_delete(
    runtime: State<'_, Runtime>,
    project_id: String,
    session_path: String,
) -> Result<SessionDeleteResult, String> {
    super::super::session_api::session_delete(&runtime, project_id, session_path).await
}

#[tauri::command]
pub fn session_update_ui_state(
    runtime: State<'_, Runtime>,
    session_path: String,
    update: SessionUiStateUpdate,
    project_id: Option<String>,
) -> Result<SessionIndexEntry, String> {
    super::super::session_api::session_update_ui_state(&runtime, session_path, update, project_id)
}
