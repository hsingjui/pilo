use crate::runtime::Runtime;
use tauri::State;

#[tauri::command]
pub async fn session_generate_title(
    runtime: State<'_, Runtime>,
    project_id: String,
    message: String,
) -> Result<Option<String>, String> {
    crate::runtime::session_naming::session_generate_title(&runtime, project_id, message).await
}
