use crate::{
    domain::{ThemeSettings, ThemeSettingsUpdate},
    runtime::{Runtime, appearance},
};
use tauri::State;

use crate::runtime::appearance::SystemFontFamily;
#[tauri::command]
pub async fn theme_settings_get(
    runtime: State<'_, Runtime>,
    initial: Option<ThemeSettings>,
) -> Result<ThemeSettings, String> {
    appearance::theme_settings_get(&runtime, initial).await
}

#[tauri::command]
pub async fn theme_settings_set(
    runtime: State<'_, Runtime>,
    update: ThemeSettingsUpdate,
) -> Result<ThemeSettings, String> {
    appearance::theme_settings_set(&runtime, update).await
}

#[tauri::command]
pub async fn system_font_families(
    runtime: State<'_, Runtime>,
) -> Result<Vec<SystemFontFamily>, String> {
    appearance::system_font_families(&runtime).await
}
