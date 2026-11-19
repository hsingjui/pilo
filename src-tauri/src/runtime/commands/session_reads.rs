use tauri::State;

use crate::{domain::SessionReadState, runtime::RuntimeEventBus};

#[tauri::command]
pub async fn session_read_states(
    events: State<'_, RuntimeEventBus>,
) -> Result<Vec<SessionReadState>, String> {
    let events = events.inner().clone();
    tokio::task::spawn_blocking(move || events.session_read_states())
        .await
        .map_err(|error| format!("failed to load session read states: {error}"))?
}

#[tauri::command]
pub async fn session_mark_read(
    events: State<'_, RuntimeEventBus>,
    project_id: String,
    session_path: String,
    revision: u64,
) -> Result<SessionReadState, String> {
    let events = events.inner().clone();
    tokio::task::spawn_blocking(move || {
        events.mark_session_read(&project_id, &session_path, revision)
    })
    .await
    .map_err(|error| format!("failed to mark session read: {error}"))?
}
