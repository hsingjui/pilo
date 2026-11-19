use tauri::{AppHandle, State};

use crate::domain::CacheKeepAliveSettings;

use super::super::{PiloRuntime, RuntimeEventBus, cache_keep_alive};

#[tauri::command]
pub fn cache_keep_alive_settings_list(
    app: AppHandle,
    connection_id: String,
) -> Result<Vec<CacheKeepAliveSettings>, String> {
    cache_keep_alive::load(&crate::desktop_paths::from_app(&app)?, &connection_id)
}

#[tauri::command]
pub async fn cache_keep_alive_settings_set(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    events: State<'_, RuntimeEventBus>,
    settings: CacheKeepAliveSettings,
) -> Result<CacheKeepAliveSettings, String> {
    cache_keep_alive::save(
        &crate::desktop_paths::from_app(&app)?,
        &runtime,
        &events,
        settings,
    )
    .await
}
