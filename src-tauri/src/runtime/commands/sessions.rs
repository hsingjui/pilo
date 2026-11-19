use tauri::State;

use super::super::session_api::SessionDeleteResult;
use crate::domain::{SessionIndexEntry, SessionReconcileResult, SessionUiStateUpdate};

use super::super::Runtime;

mod history;
mod naming;

pub use history::{
    session_external_activity, session_history, session_history_image, session_search,
};
pub use naming::session_generate_title;

#[tauri::command]
pub fn session_list(
    runtime: State<'_, Runtime>,
    project_id: String,
) -> Result<Vec<SessionIndexEntry>, String> {
    super::super::session_api::session_list(&runtime, project_id)
}

#[tauri::command]
pub async fn session_reconcile(
    runtime: State<'_, Runtime>,
    project_id: String,
) -> Result<SessionReconcileResult, String> {
    super::super::session_api::session_reconcile(&runtime, project_id).await
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
