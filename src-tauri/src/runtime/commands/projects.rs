use tauri::State;

use crate::domain::{DiscoveredProject, Project, ProjectModelCache};

use super::super::{
    Runtime, git::GitStatus, parallel::ParallelAgentInfo, preview::PreviewInfo, remote_fs::FsEntry,
    terminal::TerminalInfo,
};

#[tauri::command]
pub fn project_list(runtime: State<'_, Runtime>) -> Result<Vec<Project>, String> {
    super::super::project_api::project_list(&runtime)
}

#[tauri::command]
pub async fn project_open_in_app(
    runtime: State<'_, Runtime>,
    id: String,
    app: super::super::project_opener::ProjectApp,
    path: Option<String>,
) -> Result<(), String> {
    super::super::project_api::project_open_in_app(&runtime, id, app, path).await
}

#[tauri::command]
pub async fn project_open_in_zed_wsl(
    runtime: State<'_, Runtime>,
    id: String,
    path: Option<String>,
) -> Result<(), String> {
    super::super::project_api::project_open_in_zed_wsl(&runtime, id, path).await
}

#[tauri::command]
pub async fn project_html_report_open(
    runtime: State<'_, Runtime>,
    project_id: String,
    url: String,
) -> Result<(), String> {
    super::super::project_api::project_html_report_open(&runtime, project_id, url).await
}

#[tauri::command]
pub async fn project_file_link_open(
    runtime: State<'_, Runtime>,
    project_id: String,
    url: String,
    preview: bool,
) -> Result<Option<super::super::file_links::FileLinkPreview>, String> {
    super::super::project_api::project_file_link_open(&runtime, project_id, url, preview).await
}

#[tauri::command]
pub fn project_model_scope_get(
    runtime: State<'_, Runtime>,
    project_id: String,
) -> Result<crate::domain::ProjectModelScope, String> {
    super::super::project_api::project_model_scope_get(&runtime, project_id)
}

#[tauri::command]
pub fn project_model_scope_set(
    runtime: State<'_, Runtime>,
    project_id: String,
    models: Option<Vec<crate::domain::ProjectScopedModel>>,
) -> Result<crate::domain::ProjectModelScope, String> {
    super::super::project_api::project_model_scope_set(&runtime, project_id, models)
}

#[tauri::command]
pub fn project_model_cache_list(
    runtime: State<'_, Runtime>,
) -> Result<Vec<ProjectModelCache>, String> {
    super::super::project_api::project_model_cache_list(&runtime)
}

#[tauri::command]
pub fn project_model_cache_set(
    runtime: State<'_, Runtime>,
    project_id: String,
    models: Vec<serde_json::Value>,
    commands: Option<Vec<serde_json::Value>>,
    default_model: Option<serde_json::Value>,
    default_thinking_level: Option<String>,
    refreshed_at_ms: u64,
) -> Result<ProjectModelCache, String> {
    super::super::project_api::project_model_cache_set(
        &runtime,
        project_id,
        models,
        commands,
        default_model,
        default_thinking_level,
        refreshed_at_ms,
    )
}

#[tauri::command]
pub async fn project_add(
    runtime: State<'_, Runtime>,
    connection_id: String,
    path: String,
) -> Result<Project, String> {
    super::super::project_api::project_add(&runtime, connection_id, path).await
}

#[tauri::command]
pub async fn project_refresh(runtime: State<'_, Runtime>, id: String) -> Result<Project, String> {
    super::super::project_api::project_refresh(&runtime, id).await
}

#[tauri::command]
pub fn project_touch(runtime: State<'_, Runtime>, id: String) -> Result<Project, String> {
    super::super::project_api::project_touch(&runtime, id)
}

#[tauri::command]
pub fn project_reorder(
    runtime: State<'_, Runtime>,
    connection_id: String,
    project_ids: Vec<String>,
) -> Result<Vec<Project>, String> {
    super::super::project_api::project_reorder(&runtime, connection_id, project_ids)
}

#[tauri::command]
pub async fn project_remove(
    runtime: State<'_, Runtime>,
    id: String,
) -> Result<Vec<Project>, String> {
    super::super::project_api::project_remove(&runtime, id).await
}

#[tauri::command]
pub async fn project_git_status(
    runtime: State<'_, Runtime>,
    id: String,
) -> Result<GitStatus, String> {
    super::super::project_api::project_git_status(&runtime, id).await
}

#[tauri::command]
pub async fn project_git_diff(
    runtime: State<'_, Runtime>,
    id: String,
    path: Option<String>,
    staged: bool,
) -> Result<String, String> {
    super::super::project_api::project_git_diff(&runtime, id, path, staged).await
}

#[tauri::command]
pub async fn project_terminal_open(
    runtime: State<'_, Runtime>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, String> {
    super::super::project_api::project_terminal_open(&runtime, id, cols, rows).await
}

#[tauri::command]
pub async fn terminal_write(
    runtime: State<'_, Runtime>,
    terminal_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    super::super::project_api::terminal_write(&runtime, terminal_id, data).await
}

#[tauri::command]
pub async fn terminal_resize(
    runtime: State<'_, Runtime>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    super::super::project_api::terminal_resize(&runtime, terminal_id, cols, rows).await
}

#[tauri::command]
pub async fn terminal_close(
    runtime: State<'_, Runtime>,
    terminal_id: String,
) -> Result<(), String> {
    super::super::project_api::terminal_close(&runtime, terminal_id).await
}

#[tauri::command]
pub async fn parallel_agent_list(
    runtime: State<'_, Runtime>,
    project_id: String,
) -> Result<Vec<ParallelAgentInfo>, String> {
    super::super::project_api::parallel_agent_list(&runtime, project_id).await
}

#[tauri::command]
pub async fn parallel_agent_create(
    runtime: State<'_, Runtime>,
    project_id: String,
    name: String,
    prompt: Option<String>,
) -> Result<ParallelAgentInfo, String> {
    super::super::project_api::parallel_agent_create(&runtime, project_id, name, prompt).await
}

#[tauri::command]
pub async fn parallel_agent_send(
    runtime: State<'_, Runtime>,
    agent_id: String,
    message: String,
) -> Result<(), String> {
    super::super::project_api::parallel_agent_send(&runtime, agent_id, message).await
}

#[tauri::command]
pub async fn parallel_agent_stop(
    runtime: State<'_, Runtime>,
    agent_id: String,
) -> Result<(), String> {
    super::super::project_api::parallel_agent_stop(&runtime, agent_id).await
}

#[tauri::command]
pub async fn parallel_agent_remove(
    runtime: State<'_, Runtime>,
    project_id: String,
    agent_id: String,
) -> Result<(), String> {
    super::super::project_api::parallel_agent_remove(&runtime, project_id, agent_id).await
}

#[tauri::command]
pub async fn project_preview_ports(
    runtime: State<'_, Runtime>,
    project_id: String,
) -> Result<Vec<u16>, String> {
    super::super::project_api::project_preview_ports(&runtime, project_id).await
}

#[tauri::command]
pub async fn project_preview_open(
    runtime: State<'_, Runtime>,
    project_id: String,
    port: u16,
) -> Result<PreviewInfo, String> {
    super::super::project_api::project_preview_open(&runtime, project_id, port).await
}

#[tauri::command]
pub async fn project_preview_close(
    runtime: State<'_, Runtime>,
    preview_id: String,
) -> Result<(), String> {
    super::super::project_api::project_preview_close(&runtime, preview_id).await
}

#[tauri::command]
pub async fn project_fs_read_dir(
    runtime: State<'_, Runtime>,
    id: String,
    path: String,
) -> Result<Vec<FsEntry>, String> {
    super::super::project_api::project_fs_read_dir(&runtime, id, path).await
}

#[tauri::command]
pub fn local_pick_project_directory(runtime: State<'_, Runtime>) -> Option<String> {
    super::super::project_api::local_pick_project_directory(&runtime)
}

#[tauri::command]
pub async fn connection_fs_read_dir(
    runtime: State<'_, Runtime>,
    connection_id: String,
    path: String,
) -> Result<Vec<FsEntry>, String> {
    super::super::project_api::connection_fs_read_dir(&runtime, connection_id, path).await
}

#[tauri::command]
pub async fn project_fs_read_file(
    runtime: State<'_, Runtime>,
    id: String,
    path: String,
) -> Result<Vec<u8>, String> {
    super::super::project_api::project_fs_read_file(&runtime, id, path).await
}

#[tauri::command]
pub async fn project_fs_read_image(
    runtime: State<'_, Runtime>,
    id: String,
    path: String,
) -> Result<Vec<u8>, String> {
    super::super::project_api::project_fs_read_image(&runtime, id, path).await
}

#[tauri::command]
pub async fn project_chat_file_upload(
    runtime: State<'_, Runtime>,
    id: String,
    name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    super::super::project_api::project_chat_file_upload(&runtime, id, name, data).await
}

#[tauri::command]
pub async fn project_chat_file_remove(
    runtime: State<'_, Runtime>,
    id: String,
    path: String,
) -> Result<(), String> {
    super::super::project_api::project_chat_file_remove(&runtime, id, path).await
}

#[tauri::command]
pub async fn project_fs_write_file(
    runtime: State<'_, Runtime>,
    id: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    super::super::project_api::project_fs_write_file(&runtime, id, path, data).await
}

#[tauri::command]
pub async fn project_fs_stat(
    runtime: State<'_, Runtime>,
    id: String,
    path: String,
) -> Result<FsEntry, String> {
    super::super::project_api::project_fs_stat(&runtime, id, path).await
}

#[tauri::command]
pub async fn project_fs_mkdir(
    runtime: State<'_, Runtime>,
    id: String,
    path: String,
) -> Result<(), String> {
    super::super::project_api::project_fs_mkdir(&runtime, id, path).await
}

#[tauri::command]
pub async fn project_fs_rename(
    runtime: State<'_, Runtime>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    super::super::project_api::project_fs_rename(&runtime, id, from, to).await
}

#[tauri::command]
pub async fn project_fs_remove(
    runtime: State<'_, Runtime>,
    id: String,
    path: String,
) -> Result<(), String> {
    super::super::project_api::project_fs_remove(&runtime, id, path).await
}

#[tauri::command]
pub async fn project_fs_search(
    runtime: State<'_, Runtime>,
    id: String,
    query: String,
) -> Result<Vec<String>, String> {
    super::super::project_api::project_fs_search(&runtime, id, query).await
}

#[tauri::command]
pub async fn project_discover(
    runtime: State<'_, Runtime>,
    connection_id: String,
) -> Result<Vec<DiscoveredProject>, String> {
    super::super::project_api::project_discover(&runtime, connection_id).await
}
