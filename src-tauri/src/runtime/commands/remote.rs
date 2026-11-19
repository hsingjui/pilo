use tauri::{AppHandle, State};

use crate::domain::RemoteAccessAddress;

use super::super::{
    Runtime,
    remote::{self, RemoteHostState},
};

#[tauri::command]
pub async fn remote_host_state(runtime: State<'_, Runtime>) -> Result<RemoteHostState, String> {
    remote::remote_host_state(&runtime).await
}

#[tauri::command]
pub async fn remote_lan_addresses(runtime: State<'_, Runtime>) -> Result<Vec<String>, String> {
    remote::remote_lan_addresses(&runtime).await
}

#[tauri::command]
pub async fn remote_set_enabled(
    runtime: State<'_, Runtime>,
    app: AppHandle,
    enabled: bool,
) -> Result<RemoteHostState, String> {
    remote::remote_set_enabled(&runtime, app, enabled).await
}

#[tauri::command]
pub async fn remote_set_port(
    runtime: State<'_, Runtime>,
    app: AppHandle,
    port: u16,
) -> Result<RemoteHostState, String> {
    remote::remote_set_port(&runtime, app, port).await
}

#[tauri::command]
pub async fn remote_set_public_base_url(
    runtime: State<'_, Runtime>,
    public_base_url: String,
) -> Result<RemoteHostState, String> {
    remote::remote_set_public_base_url(&runtime, public_base_url).await
}

#[tauri::command]
pub async fn remote_set_addresses(
    runtime: State<'_, Runtime>,
    addresses: Vec<RemoteAccessAddress>,
    entry_address_id: String,
) -> Result<RemoteHostState, String> {
    remote::remote_set_addresses(&runtime, addresses, entry_address_id).await
}

#[tauri::command]
pub async fn remote_pairing_regenerate(
    runtime: State<'_, Runtime>,
) -> Result<RemoteHostState, String> {
    remote::remote_pairing_regenerate(&runtime).await
}

#[tauri::command]
pub async fn remote_device_revoke(
    runtime: State<'_, Runtime>,
    device_id: String,
) -> Result<RemoteHostState, String> {
    remote::remote_device_revoke(&runtime, device_id).await
}

#[tauri::command]
pub async fn remote_device_rename(
    runtime: State<'_, Runtime>,
    device_id: String,
    name: String,
) -> Result<RemoteHostState, String> {
    remote::remote_device_rename(&runtime, device_id, name).await
}
