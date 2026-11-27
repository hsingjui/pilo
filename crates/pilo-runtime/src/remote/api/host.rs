use axum::{
    Json,
    extract::Query,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{HostRequest, host_error};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct BootstrapQuery {
    include_preferences: bool,
    include_ui_state: bool,
}

pub(super) async fn bootstrap(host: HostRequest, Query(query): Query<BootstrapQuery>) -> Response {
    let params = json!({
        "includePreferences": query.include_preferences,
        "includeUiState": query.include_ui_state,
        "includeLocalPiResources": true,
    });
    match host.call("host.bootstrap", params).await {
        Ok(Value::Object(mut snapshot)) => {
            let sequence = snapshot
                .remove("eventSequence")
                .expect("Host bootstrap has an event cut");
            snapshot.insert("latestSequence".into(), sequence);
            Json(snapshot).into_response()
        }
        Ok(_) => host_error(crate::host_api::HostApiError::internal(
            "invalid Host bootstrap response",
        )),
        Err(error) => host_error(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LocalPiResourcesUpdate {
    connection_id: String,
    enabled: bool,
}

pub(super) async fn local_pi_resources_set(
    host: HostRequest,
    Json(update): Json<LocalPiResourcesUpdate>,
) -> Response {
    host.no_content(
        "connection.localPiResources.set",
        json!({"connectionId": update.connection_id, "enabled": update.enabled}),
    )
    .await
}

pub(super) async fn preferences_get(host: HostRequest) -> Response {
    host.json("preferences.get", json!({})).await
}

pub(super) async fn preferences_patch(
    host: HostRequest,
    Json(patch): Json<serde_json::Map<String, Value>>,
) -> Response {
    host.json("preferences.patch", json!({"patch": patch}))
        .await
}

pub(super) async fn theme_settings(host: HostRequest) -> Response {
    host.json("theme.get", json!({})).await
}

pub(super) async fn theme_settings_set(
    host: HostRequest,
    Json(update): Json<pilo_domain::ThemeSettingsUpdate>,
) -> Response {
    host.json("theme.set", json!({"update": update})).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_api::{Principal, ScopeSet};
    use crate::{
        Runtime,
        bootstrap::tests::runtime_with_mid_snapshot_change,
        events::{EventBatch, EventQueueLimits},
        host_paths::HostPaths,
        storage,
    };
    use axum::http::StatusCode;

    fn state(runtime: Runtime) -> HostRequest {
        HostRequest {
            runtime,
            principal: Principal::Device {
                id: "test".into(),
                scopes: ScopeSet::Chat,
            },
        }
    }

    #[tokio::test]
    async fn remote_cut_precedes_all_snapshot_reads_and_does_not_skip_a_later_change() {
        let (runtime, root) = runtime_with_mid_snapshot_change("remote-cut");
        let mut stream = runtime.subscribe_events(EventQueueLimits {
            max_events: 10,
            max_bytes: 4096,
        });
        let response = bootstrap(state(runtime.clone()), Query(BootstrapQuery::default())).await;
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
    async fn remote_bootstrap_can_include_preferences_and_ui_state_after_the_event_cut() {
        let root = std::env::temp_dir().join(format!(
            "pilo-remote-preferences-{}-{}",
            std::process::id(),
            storage::now_ms()
        ));
        let runtime = Runtime::new(HostPaths::for_test(root.clone()));
        let preferences = crate::preferences::preferences_patch(
            &runtime,
            serde_json::Map::from_iter([("locale".into(), Value::from("zh-CN"))]),
            None,
        )
        .unwrap();
        let projects = crate::project::list(&runtime).unwrap();
        let db = storage::open_with_paths(&runtime.paths).unwrap();
        let theme = storage::get_theme_settings(&db).unwrap();
        let read_state =
            storage::complete_session_turn(&db, &projects[0].id, "session.jsonl").unwrap();
        drop(db);
        let expected_cut = runtime.events.snapshot_sequence();
        let response = bootstrap(
            state(runtime.clone()),
            Query(BootstrapQuery {
                include_preferences: true,
                include_ui_state: true,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let snapshot: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(snapshot["latestSequence"], expected_cut);
        assert_eq!(
            snapshot["preferences"],
            serde_json::to_value(preferences).unwrap()
        );
        assert_eq!(
            snapshot["uiState"]["themeSettings"],
            serde_json::to_value(theme).unwrap()
        );
        assert_eq!(
            snapshot["uiState"]["sessionReadStates"],
            serde_json::json!([read_state])
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
            bootstrap(state(runtime), Query(BootstrapQuery::default()))
                .await
                .status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
