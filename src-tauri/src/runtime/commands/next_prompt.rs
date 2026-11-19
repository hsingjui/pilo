use tauri::State;

use crate::domain::{NextPromptModel, NextPromptRequest, NextPromptSettings};

use super::super::{Runtime, next_prompt};

#[tauri::command]
pub fn next_prompt_settings_get(
    runtime: State<'_, Runtime>,
    connection_id: String,
) -> Result<NextPromptSettings, String> {
    next_prompt::next_prompt_settings_get(&runtime, connection_id)
}

#[tauri::command]
pub fn next_prompt_settings_set(
    runtime: State<'_, Runtime>,
    connection_id: String,
    enabled: bool,
    model: Option<NextPromptModel>,
) -> Result<NextPromptSettings, String> {
    next_prompt::next_prompt_settings_set(&runtime, connection_id, enabled, model)
}

#[tauri::command]
pub async fn next_prompt_request(
    runtime: State<'_, Runtime>,
    request: NextPromptRequest,
) -> Result<(), String> {
    next_prompt::next_prompt_request(&runtime, request).await
}
