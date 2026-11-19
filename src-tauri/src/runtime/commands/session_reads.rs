use tauri::State;

use crate::{
    domain::SessionReadState,
    runtime::{Runtime, handle},
};

#[tauri::command]
pub async fn session_read_states(
    runtime: State<'_, Runtime>,
) -> Result<Vec<SessionReadState>, String> {
    handle::session_read_states(&runtime).await
}

#[tauri::command]
pub async fn session_mark_read(
    runtime: State<'_, Runtime>,
    project_id: String,
    session_path: String,
    revision: u64,
) -> Result<SessionReadState, String> {
    handle::session_mark_read(&runtime, project_id, session_path, revision).await
}
