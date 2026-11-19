use tauri::{AppHandle, State};

use crate::domain::{NextPromptModel, NextPromptRequest, NextPromptSettings};

use super::super::{PiloRuntime, RuntimeEventBus, next_prompt};

#[tauri::command]
pub fn next_prompt_settings_get(
    app: AppHandle,
    connection_id: String,
) -> Result<NextPromptSettings, String> {
    next_prompt::load(&crate::desktop_paths::from_app(&app)?, &connection_id)
}

#[tauri::command]
pub fn next_prompt_settings_set(
    app: AppHandle,
    events: State<'_, RuntimeEventBus>,
    connection_id: String,
    enabled: bool,
    model: Option<NextPromptModel>,
) -> Result<NextPromptSettings, String> {
    next_prompt::save(
        &crate::desktop_paths::from_app(&app)?,
        &events,
        &connection_id,
        enabled,
        model,
    )
}

#[tauri::command]
pub async fn next_prompt_request(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    request: NextPromptRequest,
) -> Result<(), String> {
    next_prompt::request(&crate::desktop_paths::from_app(&app)?, &runtime, request).await
}
