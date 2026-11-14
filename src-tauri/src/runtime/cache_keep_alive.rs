use serde_json::json;

use crate::domain::CacheKeepAliveSettings;

use super::{
    PiloRuntime, RuntimeEventBus,
    events::{RuntimeEvent, RuntimeEventEnvelope},
    host_paths::HostPaths,
    storage,
};

pub(crate) fn load(
    paths: &HostPaths,
    connection_id: &str,
) -> Result<Vec<CacheKeepAliveSettings>, String> {
    storage::list_cache_keep_alive_settings(&storage::open_with_paths(paths)?, connection_id)
}

pub(crate) async fn configure_session(
    paths: &HostPaths,
    runtime: &PiloRuntime,
    session_key: &str,
    connection_id: &str,
) -> Result<(), String> {
    let _policy = runtime.pi_resource_policy.read().await;
    let settings = load(paths, connection_id)?;
    runtime
        .chat_sessions
        .configure_cache_keep_alive(session_key, json!(settings))
        .await
}

pub(crate) async fn save(
    paths: &HostPaths,
    runtime: &PiloRuntime,
    events: &RuntimeEventBus,
    settings: CacheKeepAliveSettings,
) -> Result<CacheKeepAliveSettings, String> {
    let settings =
        storage::set_cache_keep_alive_settings(&storage::open_with_paths(paths)?, settings)?;
    events.send(RuntimeEventEnvelope {
        session_key: None,
        project_id: None,
        timestamp_ms: None,
        event: RuntimeEvent::CacheKeepAliveSettingsChanged {
            settings: settings.clone(),
        },
    });
    // Only existing processes: saving a preference must never launch Pi.
    for state in runtime.chat_sessions.states().await {
        let project = storage::get_project(&storage::open_with_paths(paths)?, &state.project_id)?;
        if project.is_some_and(|project| project.connection.id == settings.connection_id)
            && let Err(error) =
                configure_session(paths, runtime, &state.session_key, &settings.connection_id).await
        {
            log::warn!(target: "cache-keep-alive", "failed to update running session: {error}");
        }
    }
    Ok(settings)
}
