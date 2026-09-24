use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, State, ipc::Channel};

use super::super::{
    PiloRuntime,
    chat_service::{self, ChatSessionRequest},
    events::{RuntimeEventBus, RuntimeEventEnvelope, TauriEventSink},
    host_paths::HostPaths,
    pi_workspace, project,
    server_pi::PiLaunchOptions,
    session_snapshot::PiSessionSnapshot,
};

#[tauri::command]
pub fn runtime_subscribe_events(
    events: State<'_, RuntimeEventBus>,
    channel: Channel<RuntimeEventEnvelope>,
) {
    events.subscribe(channel);
}

#[tauri::command]
// Tauri commands expose their arguments flat; the chat session fields are part of the command surface.
#[allow(clippy::too_many_arguments)]
pub async fn chat_session_prepare(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    events: State<'_, RuntimeEventBus>,
    project_id: String,
    session_key: String,
    session_path: Option<String>,
    no_session: bool,
    extensions: Option<Vec<String>>,
) -> Result<PiSessionSnapshot, String> {
    chat_service::prepare(
        &HostPaths::from_app(&app)?,
        &runtime,
        events.inner().clone(),
        ChatSessionRequest {
            project_id,
            session_key,
            session_path,
            no_session,
            extensions: extensions.unwrap_or_default(),
        },
    )
    .await
}

#[tauri::command]
// Tauri commands expose their arguments flat; the chat session fields are part of the command surface.
#[allow(clippy::too_many_arguments)]
pub async fn chat_session_start(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    events: State<'_, RuntimeEventBus>,
    project_id: String,
    session_key: String,
    session_path: Option<String>,
    no_session: bool,
    extensions: Option<Vec<String>>,
) -> Result<PiSessionSnapshot, String> {
    chat_service::start(
        &HostPaths::from_app(&app)?,
        &runtime,
        events.inner().clone(),
        ChatSessionRequest {
            project_id,
            session_key,
            session_path,
            no_session,
            extensions: extensions.unwrap_or_default(),
        },
    )
    .await
}

#[tauri::command]
pub async fn chat_session_send_rpc(
    runtime: State<'_, PiloRuntime>,
    session_key: String,
    command: Value,
) -> Result<(), String> {
    runtime.chat_sessions.send(&session_key, command).await
}

#[tauri::command]
pub async fn chat_session_stop(
    runtime: State<'_, PiloRuntime>,
    session_key: String,
    reason: Option<String>,
) -> Result<(), String> {
    runtime
        .chat_sessions
        .stop(&session_key, reason.as_deref())
        .await
}

#[tauri::command]
pub async fn chat_session_state(
    runtime: State<'_, PiloRuntime>,
    session_key: String,
) -> Result<Option<super::super::chat_sessions::ChatSessionState>, String> {
    Ok(runtime.chat_sessions.state(&session_key).await)
}

#[tauri::command]
pub async fn chat_session_states(
    runtime: State<'_, PiloRuntime>,
) -> Result<Vec<super::super::chat_sessions::ChatSessionState>, String> {
    Ok(runtime.chat_sessions.states().await)
}

#[tauri::command]
pub async fn project_start_pi(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
) -> Result<PiSessionSnapshot, String> {
    let project = project::get(&app, &id)?;
    project::touch(&app, &project.id)?;
    let profile = pi_workspace::resolve_pi_runtime(&app, &project, Vec::new())?;
    runtime
        .project_pi_session
        .lock()
        .await
        .spawn(
            Arc::clone(&runtime.servers),
            TauriEventSink::new(app),
            &profile.project,
            PiLaunchOptions {
                extensions: profile.extensions,
                disable_builtin_tools: profile.disable_builtin_tools,
                disable_extension_discovery: profile.disable_extension_discovery,
                disable_context_files: profile.disable_context_files,
                ..PiLaunchOptions::default()
            },
        )
        .await
}

#[tauri::command]
pub async fn runtime_get_pi_state(
    runtime: State<'_, PiloRuntime>,
) -> Result<PiSessionSnapshot, String> {
    Ok(runtime.project_pi_session.lock().await.snapshot())
}

#[tauri::command]
pub async fn runtime_stop_pi(runtime: State<'_, PiloRuntime>) -> Result<PiSessionSnapshot, String> {
    runtime.project_pi_session.lock().await.stop().await
}

#[tauri::command]
pub async fn runtime_restart_pi(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
) -> Result<PiSessionSnapshot, String> {
    runtime
        .project_pi_session
        .lock()
        .await
        .restart(Arc::clone(&runtime.servers), TauriEventSink::new(app))
        .await
}

#[tauri::command]
pub async fn runtime_abort_pi(runtime: State<'_, PiloRuntime>) -> Result<(), String> {
    runtime.project_pi_session.lock().await.abort().await
}

#[tauri::command]
pub async fn runtime_send_rpc(
    runtime: State<'_, PiloRuntime>,
    command: Value,
) -> Result<(), String> {
    runtime
        .project_pi_session
        .lock()
        .await
        .send_rpc(command)
        .await
}
