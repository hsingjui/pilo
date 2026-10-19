use tauri::{AppHandle, State};

use crate::domain::{PromptEnhancementModel, PromptEnhancementSettings};

use super::super::{PiloRuntime, RuntimeEventBus, host_paths::HostPaths, prompt_enhancement};

#[tauri::command]
pub fn prompt_enhancement_settings_get(
    app: AppHandle,
    connection_id: String,
) -> Result<PromptEnhancementSettings, String> {
    prompt_enhancement::load(&HostPaths::from_app(&app)?, &connection_id)
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
        &HostPaths::from_app(&app)?,
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
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    draft: String,
    model: Option<PromptEnhancementModel>,
) -> Result<String, String> {
    prompt_enhancement::enhance(
        &app,
        &runtime,
        &HostPaths::from_app(&app)?,
        &project_id,
        &draft,
        model,
    )
    .await
}
