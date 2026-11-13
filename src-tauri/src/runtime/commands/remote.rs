use tauri::{AppHandle, State};

use crate::domain::{RemoteAccessAddress, RemoteAccessConfig};

use super::super::remote::{RemoteHostState, RemoteServerManager};

#[tauri::command]
pub async fn remote_host_state(
    app: AppHandle,
    remote: State<'_, RemoteServerManager>,
) -> Result<RemoteHostState, String> {
    remote.snapshot(&app).await
}

#[tauri::command]
pub async fn remote_lan_addresses() -> Result<Vec<String>, String> {
    super::super::remote::list_lan_ips().await
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
pub async fn remote_set_port(
    app: AppHandle,
    remote: State<'_, RemoteServerManager>,
    port: u16,
) -> Result<RemoteHostState, String> {
    remote.set_port(app, port).await
}

#[tauri::command]
pub async fn remote_set_public_base_url(
    app: AppHandle,
    remote: State<'_, RemoteServerManager>,
    public_base_url: String,
) -> Result<RemoteHostState, String> {
    remote.set_public_base_url(app, &public_base_url).await
}

#[tauri::command]
pub async fn remote_set_addresses(
    app: AppHandle,
    remote: State<'_, RemoteServerManager>,
    addresses: Vec<RemoteAccessAddress>,
    entry_address_id: String,
) -> Result<RemoteHostState, String> {
    remote
        .set_addresses(
            app,
            RemoteAccessConfig {
                addresses,
                entry_address_id,
            },
        )
        .await
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

#[tauri::command]
pub async fn remote_device_rename(
    app: AppHandle,
    remote: State<'_, RemoteServerManager>,
    device_id: String,
    name: String,
) -> Result<RemoteHostState, String> {
    remote.rename_device(&app, &device_id, &name).await
}
