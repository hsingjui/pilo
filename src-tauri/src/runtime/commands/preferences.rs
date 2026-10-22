use serde_json::{Map, Value};
use tauri::{AppHandle, State};

use super::super::{
    RuntimeEventBus,
    preferences::{self, PreferencesSnapshot},
};

#[tauri::command]
pub fn preferences_get(app: AppHandle) -> Result<PreferencesSnapshot, String> {
    preferences::load(&app)
}

#[tauri::command]
pub fn preferences_patch(
    app: AppHandle,
    events: State<'_, RuntimeEventBus>,
    patch: Map<String, Value>,
    initial: Option<bool>,
) -> Result<PreferencesSnapshot, String> {
    preferences::save(&app, &events, patch, initial.unwrap_or(false))
}
