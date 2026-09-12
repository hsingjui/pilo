use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::domain::{
    Connection, DiscoveredWorkspace, SessionIndexEntry, SessionReconcileResult,
    SessionUiStateUpdate, Workspace, WslDistribution,
};

use super::{
    PiloRuntime,
    events::TauriEventSink,
    git::{self, GitStatus},
    parallel::ParallelAgentInfo,
    preview::{self, PreviewInfo},
    remote_fs::{self, FsEntry},
    session_index,
    session_snapshot::PiSessionSnapshot,
    storage,
    terminal::TerminalInfo,
    workspace,
    wsl::{WslConnectionError, list_wsl_distributions},
};

#[tauri::command]
pub async fn wsl_list_distributions() -> Result<Vec<WslDistribution>, WslConnectionError> {
    list_wsl_distributions().await
}

#[tauri::command]
pub fn workspace_list(app: AppHandle) -> Result<Vec<Workspace>, String> {
    workspace::list(&app)
}

#[tauri::command]
pub async fn workspace_add(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    connection: Connection,
    path: String,
) -> Result<Workspace, String> {
    let workspace = workspace::add(&app, &runtime.servers, connection, path).await?;
    runtime.chat_sessions.open_workspace(&workspace.id).await?;
    Ok(workspace)
}

#[tauri::command]
pub async fn workspace_refresh(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
) -> Result<Workspace, String> {
    workspace::refresh(&app, &runtime.servers, &id).await
}

#[tauri::command]
pub fn workspace_touch(app: AppHandle, id: String) -> Result<Workspace, String> {
    workspace::touch(&app, &id)
}

#[tauri::command]
pub async fn workspace_remove(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
) -> Result<Vec<Workspace>, String> {
    runtime.chat_sessions.stop_workspace(&id).await?;
    workspace::remove(&app, &id)
}

#[tauri::command]
pub async fn workspace_git_status(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
) -> Result<GitStatus, String> {
    let workspace = workspace::get(&app, &id)?;
    git::status(&runtime.servers, &workspace).await
}

#[tauri::command]
pub async fn workspace_git_diff(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: Option<String>,
    staged: bool,
) -> Result<String, String> {
    let workspace = workspace::get(&app, &id)?;
    git::diff(&runtime.servers, &workspace, path.as_deref(), staged).await
}

#[tauri::command]
pub async fn workspace_terminal_open(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, String> {
    let workspace = workspace::get(&app, &id)?;
    runtime
        .terminals
        .lock()
        .await
        .open(Arc::clone(&runtime.servers), app, &workspace, cols, rows)
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
    workspace_id: String,
) -> Result<Vec<ParallelAgentInfo>, String> {
    Ok(runtime.parallel_agents.lock().await.list(&workspace_id))
}

#[tauri::command]
pub async fn parallel_agent_create(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    workspace_id: String,
    name: String,
    prompt: Option<String>,
) -> Result<ParallelAgentInfo, String> {
    let workspace = workspace::get(&app, &workspace_id)?;
    runtime
        .parallel_agents
        .lock()
        .await
        .create(Arc::clone(&runtime.servers), app, &workspace, name, prompt)
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
    workspace_id: String,
    agent_id: String,
) -> Result<(), String> {
    let workspace = workspace::get(&app, &workspace_id)?;
    runtime
        .parallel_agents
        .lock()
        .await
        .remove(&runtime.servers, &workspace, &agent_id)
        .await
}

#[tauri::command]
pub async fn workspace_preview_ports(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    workspace_id: String,
) -> Result<Vec<u16>, String> {
    let workspace = workspace::get(&app, &workspace_id)?;
    preview::detect_ports(&runtime.servers, &workspace).await
}

#[tauri::command]
pub async fn workspace_preview_open(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    workspace_id: String,
    port: u16,
) -> Result<PreviewInfo, String> {
    let workspace = workspace::get(&app, &workspace_id)?;
    runtime.previews.lock().await.open(&workspace, port).await
}

#[tauri::command]
pub async fn workspace_preview_close(
    runtime: State<'_, PiloRuntime>,
    preview_id: String,
) -> Result<(), String> {
    runtime.previews.lock().await.close(&preview_id).await
}

#[tauri::command]
pub async fn workspace_fs_read_dir(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: String,
) -> Result<Vec<FsEntry>, String> {
    let workspace = workspace::get(&app, &id)?;
    remote_fs::read_dir(&runtime.servers, &workspace, &path).await
}

#[tauri::command]
pub async fn workspace_fs_read_file(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: String,
) -> Result<Vec<u8>, String> {
    let workspace = workspace::get(&app, &id)?;
    remote_fs::read_file(&runtime.servers, &workspace, &path).await
}

#[tauri::command]
pub async fn workspace_fs_write_file(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let workspace = workspace::get(&app, &id)?;
    remote_fs::write_file(&runtime.servers, &workspace, &path, &data).await
}

#[tauri::command]
pub async fn workspace_fs_stat(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: String,
) -> Result<FsEntry, String> {
    let workspace = workspace::get(&app, &id)?;
    remote_fs::stat(&runtime.servers, &workspace, &path).await
}

#[tauri::command]
pub async fn workspace_fs_mkdir(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: String,
) -> Result<(), String> {
    let workspace = workspace::get(&app, &id)?;
    remote_fs::mkdir(&runtime.servers, &workspace, &path).await
}

#[tauri::command]
pub async fn workspace_fs_rename(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let workspace = workspace::get(&app, &id)?;
    remote_fs::rename(&runtime.servers, &workspace, &from, &to).await
}

#[tauri::command]
pub async fn workspace_fs_remove(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    path: String,
) -> Result<(), String> {
    let workspace = workspace::get(&app, &id)?;
    remote_fs::remove(&runtime.servers, &workspace, &path).await
}

#[tauri::command]
pub async fn workspace_fs_search(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
    query: String,
) -> Result<Vec<String>, String> {
    let workspace = workspace::get(&app, &id)?;
    remote_fs::search(&runtime.servers, &workspace, &query).await
}

#[tauri::command]
pub async fn workspace_discover(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    connection: Connection,
) -> Result<Vec<DiscoveredWorkspace>, String> {
    workspace::discover(&app, &runtime.servers, connection).await
}

#[tauri::command]
pub fn session_list(
    app: AppHandle,
    workspace_id: String,
) -> Result<Vec<SessionIndexEntry>, String> {
    session_index::list_cached(&app, &workspace_id)
}

#[tauri::command]
pub async fn session_reconcile(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    workspace_id: String,
) -> Result<SessionReconcileResult, String> {
    let workspace = workspace::get(&app, &workspace_id)?;
    session_index::reconcile(&app, &runtime.servers, &workspace).await
}

#[tauri::command]
pub async fn session_history(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    workspace_id: String,
    session_path: String,
) -> Result<super::session_history::SessionHistory, String> {
    let workspace = workspace::get(&app, &workspace_id)?;
    super::session_history::read_history(
        &runtime.servers,
        &runtime.session_history_cache,
        &workspace,
        &session_path,
    )
    .await
}

#[tauri::command]
pub async fn session_watch_start(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    workspace_id: String,
) -> Result<(), String> {
    let workspace = workspace::get(&app, &workspace_id)?;
    runtime
        .session_watchers
        .lock()
        .await
        .start(Arc::clone(&runtime.servers), app, workspace)
        .await
}

#[tauri::command]
pub async fn session_watch_stop(
    runtime: State<'_, PiloRuntime>,
    workspace_id: String,
) -> Result<(), String> {
    runtime
        .session_watchers
        .lock()
        .await
        .stop(&workspace_id)
        .await;
    Ok(())
}

#[tauri::command]
pub fn session_update_ui_state(
    app: AppHandle,
    session_path: String,
    update: SessionUiStateUpdate,
) -> Result<SessionIndexEntry, String> {
    storage::update_session_ui_state(&storage::open(&app)?, &session_path, &update)
}

#[tauri::command]
pub async fn chat_session_start(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    workspace_id: String,
    session_key: String,
    session_path: Option<String>,
) -> Result<PiSessionSnapshot, String> {
    let workspace = workspace::get(&app, &workspace_id)?;
    runtime
        .chat_sessions
        .ensure(
            Arc::clone(&runtime.servers),
            app,
            workspace,
            session_key,
            session_path,
        )
        .await
}

#[tauri::command]
pub async fn chat_session_send_rpc(
    runtime: State<'_, PiloRuntime>,
    session_key: String,
    command: Value,
) -> Result<(), String> {
    runtime.chat_sessions.send(&session_key, command).await
}

#[tauri::command]
pub async fn chat_session_stop(
    runtime: State<'_, PiloRuntime>,
    session_key: String,
) -> Result<(), String> {
    runtime.chat_sessions.stop(&session_key).await
}

#[tauri::command]
pub async fn workspace_start_pi(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
) -> Result<PiSessionSnapshot, String> {
    let workspace = workspace::get(&app, &id)?;
    workspace::touch(&app, &workspace.id)?;
    runtime
        .workspace_pi_session
        .lock()
        .await
        .spawn(
            Arc::clone(&runtime.servers),
            TauriEventSink::new(app),
            &workspace,
            None,
        )
        .await
}

#[tauri::command]
pub async fn runtime_get_pi_state(
    runtime: State<'_, PiloRuntime>,
) -> Result<PiSessionSnapshot, String> {
    Ok(runtime.workspace_pi_session.lock().await.snapshot())
}

#[tauri::command]
pub async fn runtime_stop_pi(runtime: State<'_, PiloRuntime>) -> Result<PiSessionSnapshot, String> {
    runtime.workspace_pi_session.lock().await.stop().await
}

#[tauri::command]
pub async fn runtime_restart_pi(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
) -> Result<PiSessionSnapshot, String> {
    runtime
        .workspace_pi_session
        .lock()
        .await
        .restart(Arc::clone(&runtime.servers), TauriEventSink::new(app))
        .await
}

#[tauri::command]
pub async fn runtime_abort_pi(runtime: State<'_, PiloRuntime>) -> Result<(), String> {
    runtime.workspace_pi_session.lock().await.abort().await
}

#[tauri::command]
pub async fn runtime_send_rpc(
    runtime: State<'_, PiloRuntime>,
    command: Value,
) -> Result<(), String> {
    runtime
        .workspace_pi_session
        .lock()
        .await
        .send_rpc(command)
        .await
}
