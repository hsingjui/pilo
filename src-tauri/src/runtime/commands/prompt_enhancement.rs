use tauri::State;

use crate::domain::{PromptEnhancementModel, PromptEnhancementSettings};

use super::super::{Runtime, prompt_enhancement};

#[tauri::command]
pub fn prompt_enhancement_settings_get(
    runtime: State<'_, Runtime>,
    connection_id: String,
) -> Result<PromptEnhancementSettings, String> {
    prompt_enhancement::prompt_enhancement_settings_get(&runtime, connection_id)
}

#[tauri::command]
pub fn prompt_enhancement_settings_set(
    runtime: State<'_, Runtime>,
    connection_id: String,
    enabled: bool,
    model: Option<PromptEnhancementModel>,
) -> Result<PromptEnhancementSettings, String> {
    prompt_enhancement::prompt_enhancement_settings_set(&runtime, connection_id, enabled, model)
}

#[tauri::command]
pub async fn prompt_enhance(
    runtime: State<'_, Runtime>,
    project_id: String,
    draft: String,
    model: Option<PromptEnhancementModel>,
) -> Result<String, String> {
    prompt_enhancement::prompt_enhance(&runtime, project_id, draft, model).await
}
