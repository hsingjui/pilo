use super::{
    git::{self, GitStatus},
    remote_fs::{self, FsEntry},
    terminal::TerminalInfo,
};
use std::sync::Arc;

use pilo_domain::{Project, ProjectModelCache};

use super::{Runtime, project, storage};

pub fn project_list(runtime: &Runtime) -> Result<Vec<Project>, String> {
    project::list(runtime)
}

pub async fn project_open_in_app(
    runtime: &Runtime,
    id: String,
    app: super::project_opener::ProjectApp,
    path: Option<String>,
) -> Result<(), String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    super::project_opener::open(runtime, &project, app, path.as_deref()).await
}

pub async fn project_file_link_open(
    runtime: &Runtime,
    project_id: String,
    url: String,
    preview: bool,
) -> Result<Option<super::file_links::FileLinkPreview>, String> {
    let project = project::ready(runtime, &runtime.servers, &project_id).await?;
    super::file_links::open_file_link(runtime, &project, &url, preview).await
}

pub fn project_model_scope_get(
    runtime: &Runtime,
    project_id: String,
) -> Result<pilo_domain::ProjectModelScope, String> {
    project::load_model_scope(runtime, &project_id)
}

pub fn project_model_scope_set(
    runtime: &Runtime,
    project_id: String,
    models: Option<Vec<pilo_domain::ProjectScopedModel>>,
) -> Result<pilo_domain::ProjectModelScope, String> {
    project::save_model_scope(runtime, &runtime.events, &project_id, models)
}

pub fn project_model_cache_get(
    runtime: &Runtime,
    project_id: &str,
) -> Result<Option<ProjectModelCache>, String> {
    storage::get_project_model_cache(&storage::open(&runtime.paths)?, project_id)
}

pub fn project_model_cache_list(runtime: &Runtime) -> Result<Vec<ProjectModelCache>, String> {
    storage::list_project_model_cache(&storage::open(&runtime.paths)?)
}

// Keep the runtime arguments aligned with the existing command surface.
#[allow(clippy::too_many_arguments)]
pub fn project_model_cache_set(
    runtime: &Runtime,
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
    storage::upsert_project_model_cache(&storage::open(&runtime.paths)?, &cache)?;
    Ok(cache)
}

pub async fn project_add(
    runtime: &Runtime,
    connection_id: String,
    path: String,
) -> Result<Project, String> {
    let project = project::add(runtime, &runtime.servers, connection_id, path).await?;
    runtime.chat_sessions.open_project(&project.id).await?;
    Ok(project)
}

pub fn project_touch(runtime: &Runtime, id: String) -> Result<Project, String> {
    project::touch(runtime, &id)
}

pub fn project_reorder(
    runtime: &Runtime,
    connection_id: String,
    project_ids: Vec<String>,
) -> Result<Vec<Project>, String> {
    project::reorder(runtime, &connection_id, &project_ids)
}

pub async fn project_remove(runtime: &Runtime, id: String) -> Result<Vec<Project>, String> {
    if project::get(runtime, &id)?.is_default_workspace() {
        return Err(
            "The default workspace cannot be removed; hide it in the connection menu".to_owned(),
        );
    }
    runtime.chat_sessions.stop_project(&id).await?;
    let _scan = super::session_api::lock_session_index(runtime, &id).await;
    let projects = runtime
        .terminals
        .remove_project_and_close(&id, || project::remove(runtime, &id))
        .await?;
    crate::session_watcher::SessionWatcherManager::stop(&runtime.session_watchers, &id).await;
    Ok(projects)
}

pub async fn project_git_status(runtime: &Runtime, id: String) -> Result<GitStatus, String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    git::status(&runtime.servers, &project).await
}

pub async fn project_git_diff(
    runtime: &Runtime,
    id: String,
    path: Option<String>,
    staged: bool,
) -> Result<String, String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    git::diff(&runtime.servers, &project, path.as_deref(), staged).await
}

pub async fn project_terminal_open(
    runtime: &Runtime,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, String> {
    project_terminal_open_for_owner(
        runtime,
        id,
        cols,
        rows,
        crate::terminal::TerminalOwner::Local,
    )
    .await
}

pub(crate) async fn project_terminal_open_for_owner(
    runtime: &Runtime,
    id: String,
    cols: u16,
    rows: u16,
    owner: crate::terminal::TerminalOwner,
) -> Result<TerminalInfo, String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    let (info, session) = runtime
        .terminals
        .start(
            Arc::clone(&runtime.servers),
            runtime.terminal_events.clone(),
            &project,
            cols,
            rows,
            owner,
        )
        .await?;
    if let Err((error, session)) = runtime
        .terminals
        .commit_if(session, || project::get(runtime, &id).map(|_| ()))
        .await
    {
        if let Err(close_error) = session.close().await {
            log::warn!(target: "terminal", "failed to close terminal {} after project removal: {close_error}", info.id);
        }
        return Err(error);
    }
    Ok(info)
}

pub async fn terminal_write(
    runtime: &Runtime,
    terminal_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    runtime
        .terminals
        .write(&crate::terminal::TerminalOwner::Local, &terminal_id, &data)
        .await
        .map_err(crate::terminal::TerminalAccessError::into_message)
}

pub async fn terminal_resize(
    runtime: &Runtime,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    runtime
        .terminals
        .resize(
            &crate::terminal::TerminalOwner::Local,
            &terminal_id,
            cols,
            rows,
        )
        .await
        .map_err(crate::terminal::TerminalAccessError::into_message)
}

pub async fn terminal_close(runtime: &Runtime, terminal_id: String) -> Result<(), String> {
    runtime
        .terminals
        .close(&crate::terminal::TerminalOwner::Local, &terminal_id)
        .await
        .map_err(crate::terminal::TerminalAccessError::into_message)
}

pub async fn connection_fs_read_dir(
    runtime: &Runtime,
    connection_id: String,
    path: String,
) -> Result<Vec<FsEntry>, String> {
    let connection = project::resolve_connection(runtime, &connection_id)?;
    if matches!(connection.kind, pilo_domain::ConnectionKind::Local) {
        return Err("local connection should use the native directory picker".to_owned());
    }
    remote_fs::read_connection_dir(&runtime.servers, &connection, &path).await
}

pub async fn project_fs_read_image(
    runtime: &Runtime,
    id: String,
    path: String,
) -> Result<Vec<u8>, String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    remote_fs::read_image(&runtime.servers, &project, &path).await
}

pub async fn project_chat_file_upload(
    runtime: &Runtime,
    id: String,
    name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    remote_fs::upload_chat_file(&runtime.servers, &project, &name, &data).await
}

pub async fn project_chat_file_remove(
    runtime: &Runtime,
    id: String,
    path: String,
) -> Result<(), String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    remote_fs::remove_chat_file(&runtime.servers, &project, &path).await
}

pub async fn project_fs_search(
    runtime: &Runtime,
    id: String,
    query: String,
) -> Result<Vec<String>, String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    remote_fs::search(&runtime.servers, &project, &query).await
}
