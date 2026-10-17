use tauri::{AppHandle, State};

use crate::domain::PromptEnhanceModel;

use super::super::{PiloRuntime, prompt_enhance};

/// Rewrite the composer draft with the selected chat model on a throwaway Pi
/// process; nothing is written to a conversation.
#[tauri::command]
pub async fn prompt_enhance(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    draft: String,
    model: Option<PromptEnhanceModel>,
) -> Result<String, String> {
    prompt_enhance::enhance_prompt(&app, &runtime, &project_id, model, &draft).await
}
