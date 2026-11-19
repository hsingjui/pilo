use super::storage;
use crate::domain::AutostartMode;
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

pub(crate) const AUTOSTART_ARG: &str = "--autostart";

pub(crate) fn saved_mode(app: &AppHandle) -> Result<AutostartMode, String> {
    storage::get_autostart_mode(&storage::open(&crate::desktop_paths::from_app(app)?)?)
}

fn set_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    (if enabled {
        manager.enable()
    } else if manager.is_enabled().map_err(|error| error.to_string())? {
        manager.disable()
    } else {
        Ok(())
    })
    .map_err(|error| format!("failed to update desktop autostart: {error}"))
}

pub(crate) fn load(app: &AppHandle) -> Result<AutostartMode, String> {
    let enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())?;
    Ok(if !enabled {
        AutostartMode::Disabled
    } else {
        match saved_mode(app)? {
            AutostartMode::Disabled => AutostartMode::Window,
            mode => mode,
        }
    })
}

pub(crate) fn save(app: &AppHandle, mode: AutostartMode) -> Result<AutostartMode, String> {
    let mut db = storage::open(&crate::desktop_paths::from_app(app)?)?;
    // Serialize settings writes across main/session windows, with rollback on OS failure.
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let was_enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())?;
    storage::set_autostart_mode(&tx, mode)?;
    set_enabled(app, mode != AutostartMode::Disabled)?;
    if let Err(error) = tx.commit() {
        if let Err(rollback) = set_enabled(app, was_enabled) {
            log::error!(target: "desktop", "failed to roll back autostart registration: {rollback}");
        }
        return Err(format!("failed to save desktop autostart: {error}"));
    }
    Ok(mode)
}

#[tauri::command]
pub(crate) async fn desktop_autostart_get(app: AppHandle) -> Result<AutostartMode, String> {
    tauri::async_runtime::spawn_blocking(move || load(&app))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn desktop_autostart_set(
    app: AppHandle,
    mode: AutostartMode,
) -> Result<AutostartMode, String> {
    tauri::async_runtime::spawn_blocking(move || save(&app, mode))
        .await
        .map_err(|error| error.to_string())?
}
