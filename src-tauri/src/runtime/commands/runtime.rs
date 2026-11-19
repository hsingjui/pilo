use super::super::{Runtime, events::RuntimeEventEnvelope, session_snapshot::PiSessionSnapshot};
use serde_json::Value;
use std::sync::Arc;
use tauri::{State, WebviewWindow, ipc::Channel};

#[tauri::command]
pub fn runtime_subscribe_events(
    window: WebviewWindow,
    runtime: State<'_, Runtime>,
    channel: Channel<RuntimeEventEnvelope>,
) {
    super::super::handle::runtime_subscribe_events(
        &runtime,
        window.label(),
        channel.id(),
        Arc::new(crate::desktop_events::TauriChannelEvents(channel)),
    );
}

#[tauri::command]
pub async fn project_mcp_server_approve(
    runtime: State<'_, Runtime>,
    project_id: String,
    server_name: String,
) -> Result<(), String> {
    super::super::runtime_api::project_mcp_server_approve(&runtime, project_id, server_name).await
}

#[tauri::command]
pub async fn chat_session_prepare(
    runtime: State<'_, Runtime>,
    project_id: String,
    session_key: String,
    session_path: Option<String>,
    no_session: bool,
    extensions: Option<Vec<String>>,
    builtin_extensions: Option<Vec<pilo_protocol::BuiltinExtension>>,
) -> Result<PiSessionSnapshot, String> {
    super::super::runtime_api::chat_session_prepare(
        &runtime,
        project_id,
        session_key,
        session_path,
        no_session,
        extensions,
        builtin_extensions,
    )
    .await
}

#[tauri::command]
pub async fn chat_session_start(
    runtime: State<'_, Runtime>,
    project_id: String,
    session_key: String,
    session_path: Option<String>,
    no_session: bool,
    extensions: Option<Vec<String>>,
    builtin_extensions: Option<Vec<pilo_protocol::BuiltinExtension>>,
) -> Result<PiSessionSnapshot, String> {
    super::super::runtime_api::chat_session_start(
        &runtime,
        project_id,
        session_key,
        session_path,
        no_session,
        extensions,
        builtin_extensions,
    )
    .await
}

#[tauri::command]
pub async fn chat_session_send_rpc(
    runtime: State<'_, Runtime>,
    session_key: String,
    command: Value,
) -> Result<(), String> {
    super::super::runtime_api::chat_session_send_rpc(&runtime, session_key, command).await
}

#[tauri::command]
pub async fn chat_session_stop(
    runtime: State<'_, Runtime>,
    session_key: String,
    reason: Option<String>,
) -> Result<(), String> {
    super::super::runtime_api::chat_session_stop(&runtime, session_key, reason).await
}

#[tauri::command]
pub async fn chat_session_detach(
    runtime: State<'_, Runtime>,
    session_key: String,
    reason: Option<String>,
) -> Result<(), String> {
    super::super::runtime_api::chat_session_detach(&runtime, session_key, reason).await
}

#[tauri::command]
pub async fn chat_session_state(
    runtime: State<'_, Runtime>,
    session_key: String,
) -> Result<Option<super::super::chat_sessions::ChatSessionState>, String> {
    super::super::runtime_api::chat_session_state(&runtime, session_key).await
}

#[tauri::command]
pub async fn chat_session_states(
    runtime: State<'_, Runtime>,
) -> Result<Vec<super::super::chat_sessions::ChatSessionState>, String> {
    super::super::runtime_api::chat_session_states(&runtime).await
}

#[tauri::command]
pub async fn project_start_pi(
    runtime: State<'_, Runtime>,
    id: String,
) -> Result<PiSessionSnapshot, String> {
    super::super::runtime_api::project_start_pi(&runtime, id).await
}

#[tauri::command]
pub async fn runtime_get_pi_state(
    runtime: State<'_, Runtime>,
) -> Result<PiSessionSnapshot, String> {
    super::super::runtime_api::runtime_get_pi_state(&runtime).await
}

#[tauri::command]
pub async fn runtime_stop_pi(runtime: State<'_, Runtime>) -> Result<PiSessionSnapshot, String> {
    super::super::runtime_api::runtime_stop_pi(&runtime).await
}

#[tauri::command]
pub async fn runtime_restart_pi(runtime: State<'_, Runtime>) -> Result<PiSessionSnapshot, String> {
    super::super::runtime_api::runtime_restart_pi(&runtime).await
}

#[tauri::command]
pub async fn runtime_abort_pi(runtime: State<'_, Runtime>) -> Result<(), String> {
    super::super::runtime_api::runtime_abort_pi(&runtime).await
}

#[tauri::command]
pub async fn runtime_send_rpc(runtime: State<'_, Runtime>, command: Value) -> Result<(), String> {
    super::super::runtime_api::runtime_send_rpc(&runtime, command).await
}
