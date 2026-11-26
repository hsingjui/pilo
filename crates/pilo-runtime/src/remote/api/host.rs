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
    let runtime_for_blocking = state.runtime.clone();
    let (projects, local_pi_resources) = match tokio::task::spawn_blocking(move || {
        let projects = crate::project::list(&runtime_for_blocking)?;
        let local_pi_resources = local_pi_resources_snapshot(&runtime_for_blocking.paths)?;
        Ok::<_, String>((projects, local_pi_resources))
    })
    .await
    {
        Ok(Ok(data)) => data,
        Ok(Err(error)) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
        Err(error) => {
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("bootstrap task failed: {error}"),
            );
        }
    };
    let runtime = state.runtime.core.clone();
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
    let mut statement = db
        .prepare(
            "SELECT id, kind_json, local_pi_resources FROM connections WHERE pi_runtime='local'",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut result = std::collections::HashMap::new();
    for row in rows {
        let (id, kind_json, enabled) = row.map_err(|error| error.to_string())?;
        if let Ok(pilo_domain::ConnectionKind::Ssh { .. }) =
            serde_json::from_str::<pilo_domain::ConnectionKind>(&kind_json)
        {
            result.insert(id, enabled);
        }
    }
    Ok(result)
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
    let paths = state.runtime.paths.clone();
    match tokio::task::spawn_blocking(move || crate::preferences::load(&paths)).await {
        Ok(Ok(settings)) => Json(settings).into_response(),
        Ok(Err(error)) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("preferences load task failed: {error}"),
        ),
    }
}

pub(super) async fn preferences_patch(
    state: RemoteHttpState,
    Json(patch): Json<serde_json::Map<String, Value>>,
) -> Response {
    let paths = state.runtime.paths.clone();
    let events = state.runtime.events.clone();
    match tokio::task::spawn_blocking(move || {
        crate::preferences::save(&paths, &events, patch, false)
    })
    .await
    {
        Ok(Ok(settings)) => Json(settings).into_response(),
        Ok(Err(error)) => api_error(StatusCode::BAD_REQUEST, &error),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("preferences save task failed: {error}"),
        ),
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
