use tauri::{AppHandle, State};

use super::super::remote::{RemoteHostState, RemoteServerManager};

#[tauri::command]
pub async fn remote_host_state(
    app: AppHandle,
    remote: State<'_, RemoteServerManager>,
) -> Result<RemoteHostState, String> {
    remote.snapshot(&app).await
}

#[tauri::command]
pub async fn remote_set_enabled(
    app: AppHandle,
    remote: State<'_, RemoteServerManager>,
    enabled: bool,
) -> Result<RemoteHostState, String> {
    remote.set_enabled(app, enabled).await
}

#[tauri::command]
pub async fn remote_pairing_regenerate(
    app: AppHandle,
    remote: State<'_, RemoteServerManager>,
) -> Result<RemoteHostState, String> {
    remote.regenerate_pairing(&app).await
}

#[tauri::command]
pub async fn remote_device_revoke(
    app: AppHandle,
    remote: State<'_, RemoteServerManager>,
    device_id: String,
) -> Result<RemoteHostState, String> {
    remote.revoke_device(&app, &device_id).await
}
