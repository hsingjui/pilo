//! Connection settings use Pi's user catalog, never a union of project caches.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::domain::PiRuntime;

use super::{
    PiloRuntime,
    pi_oneshot::{OneshotEventSink, request},
    server_pi::ServerPiSession,
    storage,
};

pub(crate) async fn load(
    app: &AppHandle,
    runtime: &PiloRuntime,
    connection_id: &str,
) -> Result<Vec<Value>, String> {
    let started = Instant::now();
    super::debug_trace::runtime_trace(
        "model_catalog.connection.begin",
        None,
        None,
        json!({ "connectionId": connection_id }),
    );
    let connection = {
        let db = storage::open(app)?;
        let connection = if connection_id == "local" {
            storage::ensure_local_connection(&db)?
        } else {
            storage::get_connection(&db, connection_id)?
                .ok_or_else(|| format!("Connection '{connection_id}' was not found"))?
        };
        // SSH workspaces configured to run Pi locally use Local Pi's user catalog.
        if connection.pi_runtime == PiRuntime::Local {
            storage::ensure_local_connection(&db)?
        } else {
            connection
        }
    };
    let mut session = ServerPiSession::default();
    let result = tokio::time::timeout(Duration::from_secs(35), async {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        session
            .spawn_connection(
                Arc::clone(&runtime.servers),
                OneshotEventSink { sender },
                &connection,
            )
            .await?;
        let catalog_started = Instant::now();
        let result = request(
            &session,
            &mut receiver,
            json!({ "type": "get_available_models" }),
        )
        .await
        .and_then(|data| {
            data["models"]
                .as_array()
                .cloned()
                .ok_or_else(|| "Pi model catalog response is missing models".to_owned())
        });
        super::debug_trace::runtime_trace(
            "model_catalog.connection_catalog.end",
            None,
            None,
            json!({
                "connectionId": connection_id,
                "ok": result.is_ok(),
                "elapsedMs": catalog_started.elapsed().as_millis(),
            }),
        );
        let cleanup_started = Instant::now();
        let stopped = session.stop().await;
        super::debug_trace::runtime_trace(
            "model_catalog.connection_cleanup.end",
            None,
            None,
            json!({
                "connectionId": connection_id,
                "ok": stopped.is_ok(),
                "elapsedMs": cleanup_started.elapsed().as_millis(),
            }),
        );
        result
    })
    .await
    .map_err(|_| "Connection model catalog timed out".to_owned())
    .and_then(|result| result);
    super::debug_trace::runtime_trace(
        "model_catalog.connection.end",
        None,
        None,
        json!({
            "connectionId": connection_id,
            "ok": result.is_ok(),
            "elapsedMs": started.elapsed().as_millis(),
            "modelCount": result.as_ref().map(|models| models.len()).ok(),
        }),
    );
    result
}
