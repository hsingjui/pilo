use super::{
    git::{self, GitStatus},
    parallel::ParallelAgentInfo,
    preview::{self, PreviewInfo},
    remote_fs::{self, FsEntry},
    terminal::TerminalInfo,
};
use std::sync::Arc;

use pilo_domain::{DiscoveredProject, Project, ProjectModelCache};

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

pub async fn project_open_in_zed_wsl(
    runtime: &Runtime,
    id: String,
    path: Option<String>,
) -> Result<(), String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    let pilo_domain::ConnectionKind::Wsl { distro } = &project.connection.kind else {
        return Err("opening Zed in WSL requires a WSL project".to_owned());
    };
    super::wsl::open_in_zed(distro, path.as_deref().unwrap_or(&project.path)).await
}

pub async fn project_html_report_open(
    runtime: &Runtime,
    project_id: String,
    url: String,
) -> Result<(), String> {
    let project = project::ready(runtime, &runtime.servers, &project_id).await?;
    super::file_links::open(runtime, &project, &url).await
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

pub async fn project_refresh(runtime: &Runtime, id: String) -> Result<Project, String> {
    project::refresh(runtime, &runtime.servers, &id).await
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
    let projects = project::remove(runtime, &id)?;
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
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    runtime
        .terminals
        .lock()
        .await
        .open(
            Arc::clone(&runtime.servers),
            runtime.host_events.clone(),
            &project,
            cols,
            rows,
        )
        .await
}

pub async fn terminal_write(
    runtime: &Runtime,
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

pub async fn terminal_resize(
    runtime: &Runtime,
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

pub async fn terminal_close(runtime: &Runtime, terminal_id: String) -> Result<(), String> {
    runtime.terminals.lock().await.close(&terminal_id).await
}

pub async fn parallel_agent_list(
    runtime: &Runtime,
    project_id: String,
) -> Result<Vec<ParallelAgentInfo>, String> {
    Ok(runtime.parallel_agents.lock().await.list(&project_id))
}

pub async fn parallel_agent_create(
    runtime: &Runtime,
    project_id: String,
    name: String,
    prompt: Option<String>,
) -> Result<ParallelAgentInfo, String> {
    let _policy = runtime.pi_resource_policy.read().await;
    let project = project::ready(runtime, &runtime.servers, &project_id).await?;
    runtime
        .parallel_agents
        .lock()
        .await
        .create(
            Arc::clone(&runtime.servers),
            runtime,
            &project,
            name,
            prompt,
        )
        .await
}

pub async fn parallel_agent_send(
    runtime: &Runtime,
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

pub async fn parallel_agent_stop(runtime: &Runtime, agent_id: String) -> Result<(), String> {
    runtime.parallel_agents.lock().await.stop(&agent_id).await
}

pub async fn parallel_agent_remove(
    runtime: &Runtime,
    project_id: String,
    agent_id: String,
) -> Result<(), String> {
    let project = project::ready(runtime, &runtime.servers, &project_id).await?;
    runtime
        .parallel_agents
        .lock()
        .await
        .remove(&runtime.servers, &project, &agent_id)
        .await
}

pub async fn project_preview_ports(
    runtime: &Runtime,
    project_id: String,
) -> Result<Vec<u16>, String> {
    let project = project::ready(runtime, &runtime.servers, &project_id).await?;
    preview::detect_ports(&runtime.servers, &project).await
}

pub async fn project_preview_open(
    runtime: &Runtime,
    project_id: String,
    port: u16,
) -> Result<PreviewInfo, String> {
    let project = project::ready(runtime, &runtime.servers, &project_id).await?;
    runtime.previews.lock().await.open(&project, port).await
}

pub async fn project_preview_close(runtime: &Runtime, preview_id: String) -> Result<(), String> {
    runtime.previews.lock().await.close(&preview_id).await
}

pub async fn project_fs_read_dir(
    runtime: &Runtime,
    id: String,
    path: String,
) -> Result<Vec<FsEntry>, String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    remote_fs::read_dir(&runtime.servers, &project, &path).await
}

pub fn local_pick_project_directory(runtime: &Runtime) -> Result<Option<String>, String> {
    Ok(runtime.shell()?.pick_directory())
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

pub async fn project_fs_read_file(
    runtime: &Runtime,
    id: String,
    path: String,
) -> Result<Vec<u8>, String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    remote_fs::read_viewer_file(&runtime.servers, &project, &path).await
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

pub async fn project_fs_write_file(
    runtime: &Runtime,
    id: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    remote_fs::write_file(&runtime.servers, &project, &path, &data).await
}

pub async fn project_fs_stat(
    runtime: &Runtime,
    id: String,
    path: String,
) -> Result<FsEntry, String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    remote_fs::stat(&runtime.servers, &project, &path).await
}

pub async fn project_fs_mkdir(runtime: &Runtime, id: String, path: String) -> Result<(), String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    remote_fs::mkdir(&runtime.servers, &project, &path).await
}

pub async fn project_fs_rename(
    runtime: &Runtime,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    remote_fs::rename(&runtime.servers, &project, &from, &to).await
}

pub async fn project_fs_remove(runtime: &Runtime, id: String, path: String) -> Result<(), String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    remote_fs::remove(&runtime.servers, &project, &path).await
}

pub async fn project_fs_search(
    runtime: &Runtime,
    id: String,
    query: String,
) -> Result<Vec<String>, String> {
    let project = project::ready(runtime, &runtime.servers, &id).await?;
    remote_fs::search(&runtime.servers, &project, &query).await
}

pub async fn project_discover(
    runtime: &Runtime,
    connection_id: String,
) -> Result<Vec<DiscoveredProject>, String> {
    project::discover(runtime, &runtime.servers, connection_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{handle::HostShell, host_events::RecordingEvents, host_paths::HostPaths};
    use std::path::{Path, PathBuf};

    struct Picker(Option<&'static str>);

    impl HostShell for Picker {
        fn cache_dir(&self) -> Result<PathBuf, String> {
            Ok(PathBuf::new())
        }

        fn open_path(&self, _path: &Path) -> Result<(), String> {
            Ok(())
        }

        fn pick_directory(&self) -> Option<String> {
            self.0.map(str::to_owned)
        }
    }

    #[test]
    fn directory_picker_reports_missing_host_services() {
        let runtime = Runtime::new(
            HostPaths::for_test(PathBuf::new()),
            Arc::new(RecordingEvents::default()),
        );
        assert_eq!(
            local_pick_project_directory(&runtime),
            Err("host shell services are unavailable".to_owned())
        );
    }

    #[test]
    fn directory_picker_preserves_selection_and_user_cancellation() {
        for selection in [Some("/workspace"), None] {
            let runtime = Runtime::new(
                HostPaths::for_test(PathBuf::new()),
                Arc::new(RecordingEvents::default()),
            )
            .with_shell(Arc::new(Picker(selection)))
            .unwrap();
            assert_eq!(
                local_pick_project_directory(&runtime),
                Ok(selection.map(str::to_owned))
            );
        }
    }
}
