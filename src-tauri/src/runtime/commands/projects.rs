use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::domain::{DiscoveredProject, Project, ProjectModelCache};

use super::super::{
    PiloRuntime,
    git::{self, GitStatus},
    parallel::ParallelAgentInfo,
    preview::{self, PreviewInfo},
    project,
    remote_fs::{self, FsEntry},
    storage,
    terminal::TerminalInfo,
};

#[tauri::command]
pub fn project_list(app: AppHandle) -> Result<Vec<Project>, String> {
    project::list(&app)
}

#[tauri::command]
pub async fn project_open_in_app(
    handle: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    app: super::super::project_opener::ProjectApp,
    path: Option<String>,
) -> Result<(), String> {
    let project = project::ready(&handle, &runtime.servers, &id).await?;
    super::super::project_opener::open(&project, app, path.as_deref()).await
}

#[tauri::command]
pub async fn project_open_in_zed_wsl(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: Option<String>,
) -> Result<(), String> {
    let project = project::ready(&app, &runtime.servers, &id).await?;
    let crate::domain::ConnectionKind::Wsl { distro } = &project.connection.kind else {
        return Err("opening Zed in WSL requires a WSL project".to_owned());
    };
    super::super::wsl::open_in_zed(distro, path.as_deref().unwrap_or(&project.path)).await
}

#[tauri::command]
pub async fn project_html_report_open(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    url: String,
) -> Result<(), String> {
    let project = project::ready(&app, &runtime.servers, &project_id).await?;
    super::super::file_links::open(&app, &project, &url).await
}

#[tauri::command]
pub async fn project_file_link_open(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    url: String,
    preview: bool,
) -> Result<Option<super::super::file_links::FileLinkPreview>, String> {
    let project = project::ready(&app, &runtime.servers, &project_id).await?;
    super::super::file_links::open_file_link(&app, &project, &url, preview).await
}

#[tauri::command]
pub fn project_model_scope_get(
    app: AppHandle,
    project_id: String,
) -> Result<crate::domain::ProjectModelScope, String> {
    project::load_model_scope(&app, &project_id)
}

#[tauri::command]
pub fn project_model_scope_set(
    app: AppHandle,
    events: State<'_, super::super::RuntimeEventBus>,
    project_id: String,
    models: Option<Vec<crate::domain::ProjectScopedModel>>,
) -> Result<crate::domain::ProjectModelScope, String> {
    project::save_model_scope(&app, &events, &project_id, models)
}

#[tauri::command]
pub fn project_model_cache_list(app: AppHandle) -> Result<Vec<ProjectModelCache>, String> {
    storage::list_project_model_cache(&storage::open(&app)?)
}

#[tauri::command]
pub fn project_model_cache_set(
    app: AppHandle,
    project_id: String,
    models: Vec<serde_json::Value>,
    commands: Option<Vec<serde_json::Value>>,
    default_model: Option<serde_json::Value>,
    default_thinking_level: Option<String>,
    refreshed_at_ms: u64,
) -> Result<ProjectModelCache, String> {
    let cache = ProjectModelCache {
        project_id,
        models,
        commands,
        default_model,
        default_thinking_level,
        refreshed_at_ms,
    };
    storage::upsert_project_model_cache(&storage::open(&app)?, &cache)?;
    Ok(cache)
}

#[tauri::command]
pub async fn project_add(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    connection_id: String,
    path: String,
) -> Result<Project, String> {
    let project = project::add(&app, &runtime.servers, connection_id, path).await?;
    runtime.chat_sessions.open_project(&project.id).await?;
    Ok(project)
}

#[tauri::command]
pub async fn project_refresh(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
) -> Result<Project, String> {
    project::refresh(&app, &runtime.servers, &id).await
}

#[tauri::command]
pub fn project_touch(app: AppHandle, id: String) -> Result<Project, String> {
    project::touch(&app, &id)
}

#[tauri::command]
pub fn project_reorder(
    app: AppHandle,
    connection_id: String,
    project_ids: Vec<String>,
) -> Result<Vec<Project>, String> {
    project::reorder(&app, &connection_id, &project_ids)
}

#[tauri::command]
pub async fn project_remove(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
) -> Result<Vec<Project>, String> {
    if project::get(&app, &id)?.is_default_workspace() {
        return Err(
            "The default workspace cannot be removed; hide it in the connection menu".to_owned(),
        );
    }
    runtime.chat_sessions.stop_project(&id).await?;
    project::remove(&app, &id)
}

#[tauri::command]
pub async fn project_git_status(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
) -> Result<GitStatus, String> {
    let project = project::ready(&app, &runtime.servers, &id).await?;
    git::status(&runtime.servers, &project).await
}

#[tauri::command]
pub async fn project_git_diff(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: Option<String>,
    staged: bool,
) -> Result<String, String> {
    let project = project::ready(&app, &runtime.servers, &id).await?;
    git::diff(&runtime.servers, &project, path.as_deref(), staged).await
}

#[tauri::command]
pub async fn project_terminal_open(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, String> {
    let project = project::ready(&app, &runtime.servers, &id).await?;
    runtime
        .terminals
        .lock()
        .await
        .open(Arc::clone(&runtime.servers), app, &project, cols, rows)
        .await
}

#[tauri::command]
pub async fn terminal_write(
    runtime: State<'_, PiloRuntime>,
    terminal_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    runtime
        .terminals
        .lock()
        .await
        .write(&terminal_id, &data)
        .await
}

#[tauri::command]
pub async fn terminal_resize(
    runtime: State<'_, PiloRuntime>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    runtime
        .terminals
        .lock()
        .await
        .resize(&terminal_id, cols, rows)
        .await
}

#[tauri::command]
pub async fn terminal_close(
    runtime: State<'_, PiloRuntime>,
    terminal_id: String,
) -> Result<(), String> {
    runtime.terminals.lock().await.close(&terminal_id).await
}

#[tauri::command]
pub async fn parallel_agent_list(
    runtime: State<'_, PiloRuntime>,
    project_id: String,
) -> Result<Vec<ParallelAgentInfo>, String> {
    Ok(runtime.parallel_agents.lock().await.list(&project_id))
}

#[tauri::command]
pub async fn parallel_agent_create(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    name: String,
    prompt: Option<String>,
) -> Result<ParallelAgentInfo, String> {
    let _policy = runtime.pi_resource_policy.read().await;
    let project = project::ready(&app, &runtime.servers, &project_id).await?;
    runtime
        .parallel_agents
        .lock()
        .await
        .create(Arc::clone(&runtime.servers), app, &project, name, prompt)
        .await
}

#[tauri::command]
pub async fn parallel_agent_send(
    runtime: State<'_, PiloRuntime>,
    agent_id: String,
    message: String,
) -> Result<(), String> {
    runtime
        .parallel_agents
        .lock()
        .await
        .send(&agent_id, message)
        .await
}

#[tauri::command]
pub async fn parallel_agent_stop(
    runtime: State<'_, PiloRuntime>,
    agent_id: String,
) -> Result<(), String> {
    runtime.parallel_agents.lock().await.stop(&agent_id).await
}

#[tauri::command]
pub async fn parallel_agent_remove(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    agent_id: String,
) -> Result<(), String> {
    let project = project::ready(&app, &runtime.servers, &project_id).await?;
    runtime
        .parallel_agents
        .lock()
        .await
        .remove(&runtime.servers, &project, &agent_id)
        .await
}

#[tauri::command]
pub async fn project_preview_ports(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
) -> Result<Vec<u16>, String> {
    let project = project::ready(&app, &runtime.servers, &project_id).await?;
    preview::detect_ports(&runtime.servers, &project).await
}

#[tauri::command]
pub async fn project_preview_open(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    port: u16,
) -> Result<PreviewInfo, String> {
    let project = project::ready(&app, &runtime.servers, &project_id).await?;
    runtime.previews.lock().await.open(&project, port).await
}

#[tauri::command]
pub async fn project_preview_close(
    runtime: State<'_, PiloRuntime>,
    preview_id: String,
) -> Result<(), String> {
    runtime.previews.lock().await.close(&preview_id).await
}

#[tauri::command]
pub async fn project_fs_read_dir(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: String,
) -> Result<Vec<FsEntry>, String> {
    let project = project::ready(&app, &runtime.servers, &id).await?;
    remote_fs::read_dir(&runtime.servers, &project, &path).await
}

#[tauri::command]
pub fn local_pick_project_directory() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn connection_fs_read_dir(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    connection_id: String,
    path: String,
) -> Result<Vec<FsEntry>, String> {
    let connection = project::resolve_connection(&app, &connection_id)?;
    if matches!(connection.kind, crate::domain::ConnectionKind::Local) {
        return Err("local connection should use the native directory picker".to_owned());
    }
    remote_fs::read_connection_dir(&runtime.servers, &connection, &path).await
}

#[tauri::command]
pub async fn project_fs_read_file(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: String,
) -> Result<Vec<u8>, String> {
    let project = project::ready(&app, &runtime.servers, &id).await?;
    remote_fs::read_viewer_file(&runtime.servers, &project, &path).await
}

#[tauri::command]
pub async fn project_fs_read_image(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: String,
) -> Result<Vec<u8>, String> {
    let project = project::ready(&app, &runtime.servers, &id).await?;
    remote_fs::read_image(&runtime.servers, &project, &path).await
}

#[tauri::command]
pub async fn project_chat_file_upload(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    let project = project::ready(&app, &runtime.servers, &id).await?;
    remote_fs::upload_chat_file(&runtime.servers, &project, &name, &data).await
}

#[tauri::command]
pub async fn project_chat_file_remove(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: String,
) -> Result<(), String> {
    let project = project::ready(&app, &runtime.servers, &id).await?;
    remote_fs::remove_chat_file(&runtime.servers, &project, &path).await
}

#[tauri::command]
pub async fn project_fs_write_file(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let project = project::ready(&app, &runtime.servers, &id).await?;
    remote_fs::write_file(&runtime.servers, &project, &path, &data).await
}

#[tauri::command]
pub async fn project_fs_stat(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: String,
) -> Result<FsEntry, String> {
    let project = project::ready(&app, &runtime.servers, &id).await?;
    remote_fs::stat(&runtime.servers, &project, &path).await
}

#[tauri::command]
pub async fn project_fs_mkdir(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: String,
) -> Result<(), String> {
    let project = project::ready(&app, &runtime.servers, &id).await?;
    remote_fs::mkdir(&runtime.servers, &project, &path).await
}

#[tauri::command]
pub async fn project_fs_rename(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let project = project::ready(&app, &runtime.servers, &id).await?;
    remote_fs::rename(&runtime.servers, &project, &from, &to).await
}

#[tauri::command]
pub async fn project_fs_remove(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: String,
) -> Result<(), String> {
    let project = project::ready(&app, &runtime.servers, &id).await?;
    remote_fs::remove(&runtime.servers, &project, &path).await
}

#[tauri::command]
pub async fn project_fs_search(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    query: String,
) -> Result<Vec<String>, String> {
    let project = project::ready(&app, &runtime.servers, &id).await?;
    remote_fs::search(&runtime.servers, &project, &query).await
}

#[tauri::command]
pub async fn project_discover(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    connection_id: String,
) -> Result<Vec<DiscoveredProject>, String> {
    project::discover(&app, &runtime.servers, connection_id).await
}
