use tauri::State;

use crate::runtime::{Runtime, session_activity::SessionExternalActivity};

use crate::runtime::session_api::SessionSearchMatch;

#[tauri::command]
pub async fn session_external_activity(
    runtime: State<'_, Runtime>,
    project_id: String,
) -> Result<Vec<SessionExternalActivity>, String> {
    crate::runtime::session_api::session_external_activity(&runtime, project_id).await
}

#[tauri::command]
pub async fn session_search(
    runtime: State<'_, Runtime>,
    project_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SessionSearchMatch>, String> {
    crate::runtime::session_api::session_search(&runtime, project_id, query, limit).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn session_history(
    runtime: State<'_, Runtime>,
    project_id: String,
    session_path: String,
    expected_file_size: Option<u64>,
    expected_file_mtime_ns: Option<String>,
    start_message: Option<usize>,
    message_limit: Option<usize>,
    include_message_index: Option<bool>,
) -> Result<tauri::ipc::Response, String> {
    crate::runtime::session_api::session_history(
        &runtime,
        project_id,
        session_path,
        expected_file_size,
        expected_file_mtime_ns,
        start_message,
        message_limit,
        include_message_index,
    )
    .await
    .map(tauri::ipc::Response::new)
}

/// Returns raw image bytes for entryId:contentIndex ids emitted on
/// user_message_start.images; the mime type is already known to the caller.
#[tauri::command]
pub async fn session_history_image(
    runtime: State<'_, Runtime>,
    project_id: String,
    session_path: String,
    image_id: String,
    expected_file_size: Option<u64>,
    expected_file_mtime_ns: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    crate::runtime::session_api::session_history_image(
        &runtime,
        project_id,
        session_path,
        image_id,
        expected_file_size,
        expected_file_mtime_ns,
    )
    .await
    .map(tauri::ipc::Response::new)
}
