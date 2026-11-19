use serde_json::{Map, Value};
use tauri::State;

use super::super::{
    Runtime,
    preferences::{self, PreferencesSnapshot},
};

#[tauri::command]
pub fn preferences_get(runtime: State<'_, Runtime>) -> Result<PreferencesSnapshot, String> {
    preferences::preferences_get(&runtime)
}

#[tauri::command]
pub fn preferences_patch(
    runtime: State<'_, Runtime>,
    patch: Map<String, Value>,
    initial: Option<bool>,
) -> Result<PreferencesSnapshot, String> {
    preferences::preferences_patch(&runtime, patch, initial)
}
