use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::domain::Connection;

use super::{
    events::TauriEventSink, pi_session::PiSessionSnapshot, process::ProcessSpec, PiloRuntime,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnPiSessionRequest {
    pub connection: Connection,
    pub process: ProcessSpec,
}

#[tauri::command]
pub async fn runtime_get_pi_state(
    runtime: State<'_, PiloRuntime>,
) -> Result<PiSessionSnapshot, String> {
    Ok(runtime.pi_session.lock().await.snapshot())
}

#[tauri::command]
pub async fn runtime_spawn_pi(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    request: SpawnPiSessionRequest,
) -> Result<PiSessionSnapshot, String> {
    runtime
        .pi_session
        .lock()
        .await
        .spawn(
            TauriEventSink::new(app),
            request.connection,
            request.process,
        )
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn runtime_stop_pi(runtime: State<'_, PiloRuntime>) -> Result<PiSessionSnapshot, String> {
    runtime
        .pi_session
        .lock()
        .await
        .stop()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn runtime_restart_pi(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
) -> Result<PiSessionSnapshot, String> {
    runtime
        .pi_session
        .lock()
        .await
        .restart(TauriEventSink::new(app))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn runtime_abort_pi(runtime: State<'_, PiloRuntime>) -> Result<(), String> {
    runtime
        .pi_session
        .lock()
        .await
        .abort()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn runtime_send_rpc(
    runtime: State<'_, PiloRuntime>,
    command: Value,
) -> Result<(), String> {
    runtime
        .pi_session
        .lock()
        .await
        .send_rpc(command)
        .await
        .map_err(|error| error.to_string())
}
