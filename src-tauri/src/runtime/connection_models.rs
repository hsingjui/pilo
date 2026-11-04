//! Connection settings use Pi's user catalog, never a union of project caches.

use std::{sync::Arc, time::Duration};

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
    tokio::time::timeout(Duration::from_secs(35), async {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        session
            .spawn_connection(
                Arc::clone(&runtime.servers),
                OneshotEventSink { sender },
                &connection,
            )
            .await?;
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
        let _ = session.stop().await;
        result
    })
    .await
    .map_err(|_| "Connection model catalog timed out".to_owned())?
}
