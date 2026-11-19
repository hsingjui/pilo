use tauri::{AppHandle, State};

use crate::domain::{PromptEnhancementModel, PromptEnhancementSettings};

use super::super::{RuntimeEventBus, prompt_enhancement};

#[tauri::command]
pub fn prompt_enhancement_settings_get(
    app: AppHandle,
    connection_id: String,
) -> Result<PromptEnhancementSettings, String> {
    prompt_enhancement::load(&crate::desktop_paths::from_app(&app)?, &connection_id)
}

#[tauri::command]
pub fn prompt_enhancement_settings_set(
    app: AppHandle,
    events: State<'_, RuntimeEventBus>,
    connection_id: String,
    enabled: bool,
    model: Option<PromptEnhancementModel>,
) -> Result<PromptEnhancementSettings, String> {
    prompt_enhancement::save(
        &crate::desktop_paths::from_app(&app)?,
        &events,
        &connection_id,
        enabled,
        model,
    )
}

/// Rewrite the composer draft on a throwaway Pi process; nothing is written to
/// a conversation. The Connection's settings decide whether this is allowed and
/// which model runs it.
#[tauri::command]
pub async fn prompt_enhance(
    app: AppHandle,
    runtime: State<'_, super::super::Runtime>,
    project_id: String,
    draft: String,
    model: Option<PromptEnhancementModel>,
) -> Result<String, String> {
    prompt_enhancement::enhance(
        &runtime,
        &crate::desktop_paths::from_app(&app)?,
        &project_id,
        &draft,
        model,
    )
    .await
}
