use std::{collections::HashMap, sync::Arc};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::{sync::Mutex as AsyncMutex, task::JoinHandle};

use crate::domain::Workspace;

use super::server_client::{SERVER_DISCONNECTED_EVENT, ServerClient, ServerManager};

pub const SESSION_WATCH_EVENT_NAME: &str = "pilo://sessions";

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SessionWatchEvent {
    Changed {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
    Backend {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        backend: String,
    },
    Error {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        message: String,
    },
}

struct WatchHandle {
    current_client: Arc<AsyncMutex<Arc<ServerClient>>>,
    stream_id: String,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub struct SessionWatcherManager {
    watchers: HashMap<String, WatchHandle>,
}

impl SessionWatcherManager {
    pub async fn start(
        &mut self,
        servers: Arc<ServerManager>,
        app: AppHandle,
        workspace: Workspace,
    ) -> Result<(), String> {
        self.stop(&workspace.id).await;
        let client = servers.client(&workspace.connection).await?;
        let stream_id = format!("session-watch:{}", workspace.id);
        let mut events = client.subscribe(&stream_id);
        client
            .request(
                "session.watch_start",
                json!({ "streamId": stream_id, "workspace": workspace.path }),
            )
            .await?;
        let current_client = Arc::new(AsyncMutex::new(Arc::clone(&client)));
        let event_stream_id = stream_id.clone();
        let workspace_id = workspace.id.clone();
        let workspace_path = workspace.path.clone();
        let connection = workspace.connection.clone();
        let event_app = app.clone();
        let event_servers = Arc::clone(&servers);
        let event_client = Arc::clone(&current_client);
        let task = tokio::spawn(async move {
            loop {
                let disconnect_message = match events.recv().await {
                    Ok(event) if event.event == SERVER_DISCONNECTED_EVENT => event
                        .data
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("pilo-server session watcher disconnected")
                        .to_owned(),
                    Ok(event) => {
                        if event.stream_id != event_stream_id {
                            continue;
                        }
                        match event.event.as_str() {
                            "session.changed" => emit_changed(&event_app, &workspace_id),
                            "session.backend" => emit_backend(
                                &event_app,
                                &workspace_id,
                                event
                                    .data
                                    .get("backend")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("server"),
                            ),
                            "session.error" => emit_error(
                                &event_app,
                                &workspace_id,
                                event
                                    .data
                                    .get("message")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("pilo-server session watcher failed"),
                            ),
                            _ => {}
                        }
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        emit_changed(&event_app, &workspace_id);
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        "pilo-server session watcher event channel closed".to_owned()
                    }
                };

                emit_error(
                    &event_app,
                    &workspace_id,
                    format!("{disconnect_message}; reconnecting session watcher"),
                );
                let mut delay = std::time::Duration::from_millis(250);
                loop {
                    tokio::time::sleep(delay).await;
                    if let Ok(next_client) = event_servers.client(&connection).await {
                        let next_events = next_client.subscribe(&event_stream_id);
                        *event_client.lock().await = Arc::clone(&next_client);
                        if next_client
                            .request(
                                "session.watch_start",
                                json!({
                                    "streamId": event_stream_id,
                                    "workspace": workspace_path,
                                }),
                            )
                            .await
                            .is_ok()
                        {
                            events = next_events;
                            emit_changed(&event_app, &workspace_id);
                            break;
                        }
                    }
                    delay = delay
                        .saturating_mul(2)
                        .min(std::time::Duration::from_secs(10));
                }
            }
        });
        self.watchers.insert(
            workspace.id,
            WatchHandle {
                current_client,
                stream_id,
                task,
            },
        );
        Ok(())
    }

    pub async fn stop(&mut self, workspace_id: &str) {
        if let Some(handle) = self.watchers.remove(workspace_id) {
            handle.task.abort();
            let client = handle.current_client.lock().await.clone();
            let _ = client
                .request(
                    "session.watch_stop",
                    json!({ "streamId": handle.stream_id }),
                )
                .await;
        }
    }

    pub async fn stop_all(&mut self) {
        let ids = self.watchers.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            self.stop(&id).await;
        }
    }
}

fn emit_changed(app: &AppHandle, workspace_id: &str) {
    let _ = app.emit(
        SESSION_WATCH_EVENT_NAME,
        SessionWatchEvent::Changed {
            workspace_id: workspace_id.to_owned(),
        },
    );
}

fn emit_backend(app: &AppHandle, workspace_id: &str, backend: &str) {
    let _ = app.emit(
        SESSION_WATCH_EVENT_NAME,
        SessionWatchEvent::Backend {
            workspace_id: workspace_id.to_owned(),
            backend: backend.to_owned(),
        },
    );
}

fn emit_error(app: &AppHandle, workspace_id: &str, message: impl Into<String>) {
    let _ = app.emit(
        SESSION_WATCH_EVENT_NAME,
        SessionWatchEvent::Error {
            workspace_id: workspace_id.to_owned(),
            message: message.into(),
        },
    );
}
