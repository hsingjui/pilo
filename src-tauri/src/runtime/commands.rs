use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::domain::{
    Connection, LocalConnection, LocalEnvironmentInfo, SshConnection, SshEnvironmentInfo,
    SshTarget, WslConnection, WslDistribution, WslEnvironmentInfo,
};

use super::{
    events::TauriEventSink,
    local::{
        prepare_local_launch, probe_local_connection, LocalConnectionError, LocalConnectionProbe,
    },
    pi_session::PiSessionSnapshot,
    process::ProcessSpec,
    ssh::{prepare_ssh_launch, probe_ssh_connection, SshConnectionError, SshConnectionProbe},
    wsl::{
        list_wsl_distributions, prepare_wsl_launch, probe_wsl_connection, WslConnectionError,
        WslConnectionProbe,
    },
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslStartPiResponse {
    pub connection: WslConnection,
    pub environment: WslEnvironmentInfo,
    pub session: PiSessionSnapshot,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshStartPiResponse {
    pub connection: SshConnection,
    pub environment: SshEnvironmentInfo,
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
pub async fn wsl_list_distributions() -> Result<Vec<WslDistribution>, WslConnectionError> {
    list_wsl_distributions().await
}

#[tauri::command]
pub async fn wsl_probe_connection(
    distro: String,
    workspace: String,
) -> Result<WslConnectionProbe, WslConnectionError> {
    probe_wsl_connection(distro, workspace).await
}

#[tauri::command]
pub async fn wsl_start_pi(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    distro: String,
    workspace: String,
) -> Result<WslStartPiResponse, WslConnectionError> {
    let launch = prepare_wsl_launch(distro, workspace).await?;
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
        .map_err(WslConnectionError::pi_spawn)?;

    Ok(WslStartPiResponse {
        connection,
        environment,
        session,
    })
}

#[tauri::command]
pub async fn ssh_probe_connection(
    target: SshTarget,
    workspace: String,
) -> Result<SshConnectionProbe, SshConnectionError> {
    probe_ssh_connection(target, workspace).await
}

#[tauri::command]
pub async fn ssh_start_pi(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    target: SshTarget,
    workspace: String,
) -> Result<SshStartPiResponse, SshConnectionError> {
    let launch = prepare_ssh_launch(target, workspace).await?;
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
        .map_err(SshConnectionError::pi_spawn)?;

    Ok(SshStartPiResponse {
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
