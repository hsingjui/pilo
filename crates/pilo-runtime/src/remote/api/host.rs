use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{pi_workspace, storage};

use super::{RemoteHttpState, api_error};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BootstrapResponse {
    projects: Vec<pilo_domain::Project>,
    chat_sessions: Vec<crate::chat_sessions::ChatSessionState>,
    latest_sequence: u64,
    local_pi_resources: std::collections::HashMap<String, bool>,
}

pub(super) async fn bootstrap(state: RemoteHttpState) -> Response {
    let latest_sequence = state.runtime.events.snapshot_sequence();
    let projects = match crate::project::list(&state.runtime) {
        Ok(projects) => projects,
        Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    };
    let runtime = state.runtime.core.clone();
    let local_pi_resources = match local_pi_resources_snapshot(&state.runtime.paths) {
        Ok(settings) => settings,
        Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    };
    Json(BootstrapResponse {
        projects,
        chat_sessions: runtime.chat_sessions.states().await,
        latest_sequence,
        local_pi_resources,
    })
    .into_response()
}

fn local_pi_resources_snapshot(
    paths: &crate::host_paths::HostPaths,
) -> Result<std::collections::HashMap<String, bool>, String> {
    let db = storage::open_with_paths(paths)?;
    storage::list_connections(&db)?
        .into_iter()
        .filter(|connection| {
            connection.pi_runtime == pilo_domain::PiRuntime::Local
                && matches!(connection.kind, pilo_domain::ConnectionKind::Ssh { .. })
        })
        .map(|connection| {
            let enabled = storage::get_local_pi_resources(&db, &connection.id)?;
            Ok((connection.id, enabled))
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LocalPiResourcesUpdate {
    connection_id: String,
    enabled: bool,
}

pub(super) async fn local_pi_resources_set(
    state: RemoteHttpState,
    Json(update): Json<LocalPiResourcesUpdate>,
) -> Response {
    match pi_workspace::set_local_pi_resources(
        &state.runtime,
        &update.connection_id,
        update.enabled,
    )
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

pub(super) async fn preferences_get(state: RemoteHttpState) -> Response {
    match crate::preferences::load(&state.runtime.paths) {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

pub(super) async fn preferences_patch(
    state: RemoteHttpState,
    Json(patch): Json<serde_json::Map<String, Value>>,
) -> Response {
    match crate::preferences::save(&state.runtime.paths, &state.runtime.events, patch, false) {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

pub(super) async fn theme_settings(state: RemoteHttpState) -> Response {
    match crate::appearance::load(state.runtime.paths.clone()).await {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

pub(super) async fn theme_settings_set(
    state: RemoteHttpState,
    Json(update): Json<pilo_domain::ThemeSettingsUpdate>,
) -> Response {
    match crate::appearance::save(
        state.runtime.paths.clone(),
        state.runtime.events.clone(),
        update,
    )
    .await
    {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Runtime,
        bootstrap::tests::runtime_with_mid_snapshot_change,
        events::{EventBatch, EventQueueLimits},
        host_paths::HostPaths,
    };
    use std::sync::Arc;

    fn state(runtime: Runtime) -> RemoteHttpState {
        RemoteHttpState {
            runtime,
            pairing: Arc::new(super::super::PairingSession::default()),
            rate_limiter: Arc::new(super::super::AuthRateLimiter::default()),
            shutdown: tokio::sync::watch::channel(false).1,
            auth_generation: tokio::sync::watch::channel(0).1,
        }
    }

    #[tokio::test]
    async fn remote_cut_precedes_all_snapshot_reads_and_does_not_skip_a_later_change() {
        let (runtime, root) = runtime_with_mid_snapshot_change("remote-cut");
        let mut stream = runtime.subscribe_events(EventQueueLimits {
            max_events: 10,
            max_bytes: 4096,
        });
        let response = bootstrap(state(runtime.clone())).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let snapshot: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(snapshot["latestSequence"], 1);
        assert_eq!(snapshot.as_object().unwrap().len(), 4);
        assert!(
            !snapshot["projects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|project| project["id"] == "changed")
        );
        assert!(
            crate::project::list(&runtime)
                .unwrap()
                .iter()
                .any(|project| project.id == "changed")
        );
        let EventBatch::Events(events) = stream.try_next_batch(10).unwrap() else {
            panic!("expected events after cut")
        };
        assert_eq!(
            events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn remote_bootstrap_keeps_storage_error_response() {
        let paths = HostPaths::with_data_dir_resolver(std::path::PathBuf::new(), || {
            Err("data unavailable".into())
        });
        let runtime = Runtime::new(paths);
        assert_eq!(
            bootstrap(state(runtime)).await.status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
