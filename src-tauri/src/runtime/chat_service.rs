use std::sync::Arc;

use crate::domain::Project;

use super::{
    PiloRuntime, RuntimeEventBus, chat_sessions::ChatSessionLaunch, host_paths::HostPaths,
    pi_workspace, session_activity::reject_external_session_owner,
    session_snapshot::PiSessionSnapshot, storage,
};

#[derive(Clone, Debug)]
pub(crate) struct ChatSessionRequest {
    pub project_id: String,
    pub session_key: String,
    pub session_path: Option<String>,
    pub no_session: bool,
    pub extensions: Vec<String>,
}

fn get_project(paths: &HostPaths, project_id: &str) -> Result<Project, String> {
    storage::get_project(&storage::open_with_paths(paths)?, project_id)?
        .ok_or_else(|| format!("Project '{project_id}' was not found"))
}

async fn resolve_launch(
    paths: &HostPaths,
    runtime: &PiloRuntime,
    request: &ChatSessionRequest,
) -> Result<(Project, ChatSessionLaunch), String> {
    let project = get_project(paths, &request.project_id)?;
    let profile =
        pi_workspace::resolve_pi_runtime_with_paths(paths, &project, request.extensions.clone())?;
    reject_external_session_owner(runtime, &profile.project, request.session_path.as_deref())
        .await?;
    Ok((
        profile.project,
        ChatSessionLaunch {
            session_path: request.session_path.clone(),
            no_session: request.no_session,
            extensions: profile.extensions,
            disable_builtin_tools: profile.disable_builtin_tools,
            disable_extension_discovery: profile.disable_extension_discovery,
            disable_context_files: profile.disable_context_files,
        },
    ))
}

pub(crate) async fn prepare(
    paths: &HostPaths,
    runtime: &PiloRuntime,
    events: RuntimeEventBus,
    request: ChatSessionRequest,
) -> Result<PiSessionSnapshot, String> {
    let (project, launch) = resolve_launch(paths, runtime, &request).await?;
    runtime
        .chat_sessions
        .prepare(
            Arc::clone(&runtime.servers),
            events,
            project,
            request.session_key,
            launch,
        )
        .await
}

pub(crate) async fn start(
    paths: &HostPaths,
    runtime: &PiloRuntime,
    events: RuntimeEventBus,
    request: ChatSessionRequest,
) -> Result<PiSessionSnapshot, String> {
    let (project, launch) = resolve_launch(paths, runtime, &request).await?;
    runtime
        .chat_sessions
        .ensure(
            Arc::clone(&runtime.servers),
            events,
            project,
            request.session_key,
            launch,
        )
        .await
}
