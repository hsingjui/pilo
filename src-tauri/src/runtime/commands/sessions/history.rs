use tauri::{AppHandle, State};

use crate::runtime::{
    PiloRuntime, Runtime, session_activity::SessionExternalActivity, session_history,
};

use super::session_runtime_project;
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

/// Returns raw image bytes for entryId:contentIndex ids emitted on
/// user_message_start.images; the mime type is already known to the caller.
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
