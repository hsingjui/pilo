use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::domain::{Connection, LocalConnection, LocalEnvironmentInfo};

use super::{
    events::TauriEventSink,
    local::{
        prepare_local_launch, probe_local_connection, LocalConnectionError, LocalConnectionProbe,
    },
    pi_session::PiSessionSnapshot,
    process::ProcessSpec,
    PiloRuntime,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnPiSessionRequest {
    pub connection: Connection,
    pub process: ProcessSpec,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStartPiResponse {
    pub connection: LocalConnection,
    pub environment: LocalEnvironmentInfo,
    pub session: PiSessionSnapshot,
}

#[tauri::command]
pub async fn local_probe_connection(
    workspace: PathBuf,
) -> Result<LocalConnectionProbe, LocalConnectionError> {
    probe_local_connection(workspace).await
}

#[tauri::command]
pub async fn local_start_pi(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    workspace: PathBuf,
) -> Result<LocalStartPiResponse, LocalConnectionError> {
    let launch = prepare_local_launch(workspace).await?;
    let connection = launch.connection.clone();
    let environment = launch.environment;
    let session = runtime
        .pi_session
        .lock()
        .await
        .spawn(
            TauriEventSink::new(app),
            Connection::from(connection.clone()),
            launch.process,
        )
        .await
        .map_err(LocalConnectionError::pi_spawn)?;

    Ok(LocalStartPiResponse {
        connection,
        environment,
        session,
    })
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
