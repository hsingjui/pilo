use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, State};

use super::super::{
    PiloRuntime, events::TauriEventSink, project, server_pi::PiLaunchOptions,
    session_snapshot::PiSessionSnapshot,
};

#[tauri::command]
pub async fn chat_session_prepare(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    session_key: String,
    session_path: Option<String>,
    no_session: bool,
) -> Result<PiSessionSnapshot, String> {
    let project = project::get(&app, &project_id)?;
    runtime
        .chat_sessions
        .prepare(
            Arc::clone(&runtime.servers),
            app,
            project,
            session_key,
            session_path,
            no_session,
        )
        .await
}

#[tauri::command]
pub async fn chat_session_start(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    session_key: String,
    session_path: Option<String>,
    no_session: bool,
) -> Result<PiSessionSnapshot, String> {
    let project = project::get(&app, &project_id)?;
    runtime
        .chat_sessions
        .ensure(
            Arc::clone(&runtime.servers),
            app,
            project,
            session_key,
            session_path,
            no_session,
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
) -> Result<(), String> {
    runtime.chat_sessions.stop(&session_key).await
}

#[tauri::command]
pub async fn chat_session_state(
    runtime: State<'_, PiloRuntime>,
    session_key: String,
) -> Result<Option<super::super::chat_sessions::ChatSessionState>, String> {
    Ok(runtime.chat_sessions.state(&session_key).await)
}

#[tauri::command]
pub async fn project_start_pi(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
) -> Result<PiSessionSnapshot, String> {
    let project = project::get(&app, &id)?;
    project::touch(&app, &project.id)?;
    runtime
        .project_pi_session
        .lock()
        .await
        .spawn(
            Arc::clone(&runtime.servers),
            TauriEventSink::new(app),
            &project,
            PiLaunchOptions::default(),
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
