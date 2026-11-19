use tauri::State;

use crate::domain::CacheKeepAliveSettings;

use super::super::{Runtime, cache_keep_alive};

#[tauri::command]
pub fn cache_keep_alive_settings_list(
    runtime: State<'_, Runtime>,
    connection_id: String,
) -> Result<Vec<CacheKeepAliveSettings>, String> {
    cache_keep_alive::cache_keep_alive_settings_list(&runtime, connection_id)
}

#[tauri::command]
pub async fn cache_keep_alive_settings_set(
    runtime: State<'_, Runtime>,
    settings: CacheKeepAliveSettings,
) -> Result<CacheKeepAliveSettings, String> {
    cache_keep_alive::cache_keep_alive_settings_set(&runtime, settings).await
}
