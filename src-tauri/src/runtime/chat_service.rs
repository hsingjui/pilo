use std::{sync::Arc, time::Instant};

use serde_json::json;

use pilo_protocol::BuiltinExtension;

use crate::domain::Project;

use super::{
    PiloRuntime, RuntimeEventBus, chat_sessions::ChatSessionLaunch, host_paths::HostPaths,
    pi_workspace, session_activity::reject_external_session_owner,
    session_snapshot::PiSessionSnapshot,
};

#[derive(Clone, Debug)]
pub(crate) struct ChatSessionRequest {
    pub project_id: String,
    pub session_key: String,
    pub session_path: Option<String>,
    pub no_session: bool,
    pub extensions: Vec<String>,
    pub builtin_extensions: Vec<BuiltinExtension>,
}

impl ChatSessionRequest {
    fn is_model_probe(&self) -> bool {
        self.builtin_extensions
            .iter()
            .any(|extension| matches!(extension, BuiltinExtension::ModelCatalog))
    }
}

async fn resolve_launch(
    paths: &HostPaths,
    runtime: &PiloRuntime,
    events: &RuntimeEventBus,
    request: &ChatSessionRequest,
) -> Result<(Project, ChatSessionLaunch, String), String> {
    let started = Instant::now();
    if request.is_model_probe() {
        super::debug_trace::runtime_trace(
            "model_catalog.resolve_launch.begin",
            Some(&request.session_key),
            None,
            json!({ "projectId": request.project_id }),
        );
    }
    let project =
        super::project::ready_with_paths(paths, &runtime.servers, events, &request.project_id)
            .await?;
    let profile =
        pi_workspace::resolve_pi_runtime_with_paths(paths, &project, request.extensions.clone())?;
    let model_probe = request.is_model_probe();
    let mut builtin_extensions = profile.builtin_extensions;
    // Probes are throwaway sessions; only normal chats load turn guards and assistance.
    if !model_probe {
        builtin_extensions.push(BuiltinExtension::StreamGuard);
        builtin_extensions.push(BuiltinExtension::NextPrompt);
        builtin_extensions.push(BuiltinExtension::CacheKeepAlive);
    }
    for extension in &request.builtin_extensions {
        if !matches!(extension, BuiltinExtension::ModelCatalog) {
            return Err("unsupported client-selected builtin extension".to_owned());
        }
        builtin_extensions.push(extension.clone());
    }
    reject_external_session_owner(runtime, &profile.project, request.session_path.as_deref())
        .await?;
    if model_probe {
        super::debug_trace::runtime_trace(
            "model_catalog.resolve_launch.end",
            Some(&request.session_key),
            None,
            json!({ "ok": true, "elapsedMs": started.elapsed().as_millis() }),
        );
    }
    Ok((
        profile.project,
        ChatSessionLaunch {
            session_path: request.session_path.clone(),
            no_session: request.no_session,
            extensions: profile.extensions,
            builtin_extensions,
            disable_builtin_tools: model_probe || profile.disable_builtin_tools,
            disable_extension_discovery: profile.disable_extension_discovery,
            disable_context_files: model_probe || profile.disable_context_files,
        },
        project.connection.id,
    ))
}

pub(crate) async fn prepare(
    paths: &HostPaths,
    runtime: &PiloRuntime,
    events: RuntimeEventBus,
    request: ChatSessionRequest,
) -> Result<PiSessionSnapshot, String> {
    let (project, launch, connection_id) =
        resolve_launch(paths, runtime, &events, &request).await?;
    let snapshot = runtime
        .chat_sessions
        .prepare(
            Arc::clone(&runtime.servers),
            events,
            project,
            request.session_key.clone(),
            launch,
        )
        .await?;
    if !request.is_model_probe()
        && let Err(error) = super::cache_keep_alive::configure_session(
            paths,
            runtime,
            &request.session_key,
            &connection_id,
        )
        .await
    {
        log::warn!(target: "cache-keep-alive", "failed to configure session: {error}");
    }
    Ok(snapshot)
}

pub(crate) async fn start(
    paths: &HostPaths,
    runtime: &PiloRuntime,
    events: RuntimeEventBus,
    request: ChatSessionRequest,
) -> Result<PiSessionSnapshot, String> {
    let (project, launch, connection_id) =
        resolve_launch(paths, runtime, &events, &request).await?;
    let snapshot = runtime
        .chat_sessions
        .ensure(
            Arc::clone(&runtime.servers),
            events,
            project,
            request.session_key.clone(),
            launch,
        )
        .await?;
    if !request.is_model_probe()
        && let Err(error) = super::cache_keep_alive::configure_session(
            paths,
            runtime,
            &request.session_key,
            &connection_id,
        )
        .await
    {
        log::warn!(target: "cache-keep-alive", "failed to configure session: {error}");
    }
    Ok(snapshot)
}
