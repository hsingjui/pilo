use std::{collections::HashMap, sync::Arc};

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::{sync::Mutex as AsyncMutex, task::JoinHandle};

use crate::domain::Project;

use super::{
    pi_workspace,
    server_client::{SERVER_DISCONNECTED_EVENT, ServerClient, ServerManager},
    session_index,
};

pub const SESSION_WATCH_EVENT_NAME: &str = "pilo://sessions";

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SessionWatchEvent {
    Changed {
        #[serde(rename = "projectId")]
        project_id: String,
    },
    Indexed {
        #[serde(rename = "projectId")]
        project_id: String,
    },
    Backend {
        #[serde(rename = "projectId")]
        project_id: String,
        backend: String,
    },
    Error {
        #[serde(rename = "projectId")]
        project_id: String,
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
        project: Project,
    ) -> Result<(), String> {
        self.stop(&project.id).await;
        let session_project = pi_workspace::resolve_session_project(&app, &project)?;
        let client = servers.client(&session_project.connection).await?;
        let stream_id = format!("session-watch:{}", project.id);
        let mut events = client.subscribe(&stream_id);
        client
            .request(
                "session.watch_start",
                json!({ "streamId": stream_id, "project": session_project.path }),
            )
            .await?;
        let current_client = Arc::new(AsyncMutex::new(Arc::clone(&client)));
        let event_stream_id = stream_id.clone();
        let project_id = project.id.clone();
        let project_path = session_project.path.clone();
        let connection = session_project.connection.clone();
        let event_project = project.clone();
        let event_app = app.clone();
        let event_servers = Arc::clone(&servers);
        let event_client = Arc::clone(&current_client);
        let task = tokio::spawn(async move {
            loop {
                let disconnect_message = match events.recv().await {
                    Some(event) if event.event == SERVER_DISCONNECTED_EVENT => event
                        .data
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("pilo-server session watcher disconnected")
                        .to_owned(),
                    Some(event) => {
                        if event.stream_id != event_stream_id {
                            continue;
                        }
                        match event.event.as_str() {
                            "session.changed" => {
                                let paths = string_array(&event.data, "paths");
                                let removed_paths = string_array(&event.data, "removedPaths");
                                let full_refresh = event
                                    .data
                                    .get("full")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(paths.is_empty() && removed_paths.is_empty());
                                if full_refresh {
                                    emit_changed(&event_app, &project_id);
                                } else {
                                    match session_index::reconcile_paths(
                                        &event_app,
                                        &event_servers,
                                        &event_project,
                                        &paths,
                                        &removed_paths,
                                    )
                                    .await
                                    {
                                        Ok(changed) if changed > 0 => {
                                            emit_indexed(&event_app, &project_id)
                                        }
                                        Ok(_) => {}
                                        Err(error) => {
                                            emit_error(
                                                &event_app,
                                                &project_id,
                                                format!(
                                                    "targeted session indexing failed: {error}"
                                                ),
                                            );
                                            emit_changed(&event_app, &project_id);
                                        }
                                    }
                                }
                            }
                            "session.backend" => emit_backend(
                                &event_app,
                                &project_id,
                                event
                                    .data
                                    .get("backend")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("server"),
                            ),
                            "session.error" => emit_error(
                                &event_app,
                                &project_id,
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
                    None => "pilo-server session watcher event channel closed".to_owned(),
                };

                emit_error(
                    &event_app,
                    &project_id,
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
                                    "project": project_path,
                                }),
                            )
                            .await
                            .is_ok()
                        {
                            events = next_events;
                            emit_changed(&event_app, &project_id);
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
            project.id,
            WatchHandle {
                current_client,
                stream_id,
                task,
            },
        );
        Ok(())
    }

    pub async fn stop(&mut self, project_id: &str) -> bool {
        let Some(handle) = self.watchers.remove(project_id) else {
            return false;
        };
        handle.task.abort();
        let client = handle.current_client.lock().await.clone();
        let _ = client
            .request(
                "session.watch_stop",
                json!({ "streamId": handle.stream_id }),
            )
            .await;
        true
    }

    pub async fn stop_all(&mut self) {
        let ids = self.watchers.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            self.stop(&id).await;
        }
    }
}

fn emit_changed(app: &AppHandle, project_id: &str) {
    let _ = app.emit(
        SESSION_WATCH_EVENT_NAME,
        SessionWatchEvent::Changed {
            project_id: project_id.to_owned(),
        },
    );
}

fn emit_indexed(app: &AppHandle, project_id: &str) {
    let _ = app.emit(
        SESSION_WATCH_EVENT_NAME,
        SessionWatchEvent::Indexed {
            project_id: project_id.to_owned(),
        },
    );
}

fn string_array(data: &Value, key: &str) -> Vec<String> {
    data.get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn emit_backend(app: &AppHandle, project_id: &str, backend: &str) {
    let _ = app.emit(
        SESSION_WATCH_EVENT_NAME,
        SessionWatchEvent::Backend {
            project_id: project_id.to_owned(),
            backend: backend.to_owned(),
        },
    );
}

fn emit_error(app: &AppHandle, project_id: &str, message: impl Into<String>) {
    let _ = app.emit(
        SESSION_WATCH_EVENT_NAME,
        SessionWatchEvent::Error {
            project_id: project_id.to_owned(),
            message: message.into(),
        },
    );
}
