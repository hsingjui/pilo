use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

use crate::domain::Project;

use super::server_client::{SERVER_DISCONNECTED_EVENT, ServerClient, ServerManager};

pub const TERMINAL_EVENT_NAME: &str = "pilo://terminal";

static TERMINAL_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub project_id: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalEvent {
    Output {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        data: Vec<u8>,
    },
    Exit {
        #[serde(rename = "terminalId")]
        terminal_id: String,
    },
    Error {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        message: String,
    },
}

struct TerminalSession {
    client: Arc<ServerClient>,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: HashMap<String, TerminalSession>,
}

impl TerminalManager {
    pub async fn open(
        &mut self,
        servers: Arc<ServerManager>,
        app: AppHandle,
        project: &Project,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalInfo, String> {
        let client = servers.client(&project.connection).await?;
        let terminal_id = format!(
            "terminal-{}-{}",
            std::process::id(),
            TERMINAL_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let mut events = client.subscribe(&terminal_id);
        let event_terminal_id = terminal_id.clone();
        let event_app = app.clone();
        let event_client = Arc::clone(&client);
        let task = tokio::spawn(async move {
            loop {
                let Some(event) = events.recv().await else {
                    let _ = event_app.emit(
                        TERMINAL_EVENT_NAME,
                        TerminalEvent::Error {
                            terminal_id: event_terminal_id.clone(),
                            message: "pilo-server terminal connection closed".to_owned(),
                        },
                    );
                    break;
                };
                if event.event == SERVER_DISCONNECTED_EVENT {
                    let _ = event_app.emit(
                        TERMINAL_EVENT_NAME,
                        TerminalEvent::Error {
                            terminal_id: event_terminal_id.clone(),
                            message: event
                                .data
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("pilo-server terminal connection closed")
                                .to_owned(),
                        },
                    );
                    if event.data.get("overflow").and_then(Value::as_bool) == Some(true) {
                        let _ = event_client
                            .request("terminal.close", json!({ "streamId": &event_terminal_id }))
                            .await;
                    }
                    break;
                }
                if event.stream_id != event_terminal_id {
                    continue;
                }
                match event.event.as_str() {
                    "terminal.output" => {
                        let data = event.binary.first().cloned().unwrap_or_default();
                        let _ = event_app.emit(
                            TERMINAL_EVENT_NAME,
                            TerminalEvent::Output {
                                terminal_id: event_terminal_id.clone(),
                                data,
                            },
                        );
                    }
                    "terminal.exit" => {
                        let _ = event_app.emit(
                            TERMINAL_EVENT_NAME,
                            TerminalEvent::Exit {
                                terminal_id: event_terminal_id.clone(),
                            },
                        );
                        break;
                    }
                    "terminal.error" => {
                        let _ = event_app.emit(
                            TERMINAL_EVENT_NAME,
                            TerminalEvent::Error {
                                terminal_id: event_terminal_id.clone(),
                                message: event
                                    .data
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("terminal error")
                                    .to_owned(),
                            },
                        );
                        break;
                    }
                    _ => {}
                }
            }
        });
        if let Err(error) = client
            .request(
                "terminal.open",
                json!({
                    "streamId": terminal_id,
                    "project": project.path,
                    "cols": cols,
                    "rows": rows,
                }),
            )
            .await
        {
            task.abort();
            return Err(error);
        }
        self.sessions
            .insert(terminal_id.clone(), TerminalSession { client, task });
        Ok(TerminalInfo {
            id: terminal_id,
            project_id: project.id.clone(),
            title: project.name.clone(),
        })
    }

    pub async fn write(&self, terminal_id: &str, data: &[u8]) -> Result<(), String> {
        let session = self
            .sessions
            .get(terminal_id)
            .ok_or_else(|| format!("terminal '{terminal_id}' is not running"))?;
        session
            .client
            .request_with_binary(
                "terminal.write",
                json!({ "streamId": terminal_id }),
                vec![data.to_vec()],
            )
            .await
            .map(|_| ())
    }

    pub async fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self
            .sessions
            .get(terminal_id)
            .ok_or_else(|| format!("terminal '{terminal_id}' is not running"))?;
        session
            .client
            .request(
                "terminal.resize",
                json!({ "streamId": terminal_id, "cols": cols, "rows": rows }),
            )
            .await
            .map(|_| ())
    }

    pub async fn close(&mut self, terminal_id: &str) -> Result<(), String> {
        let Some(session) = self.sessions.remove(terminal_id) else {
            return Ok(());
        };
        session.task.abort();
        session
            .client
            .request("terminal.close", json!({ "streamId": terminal_id }))
            .await
            .map(|_| ())
    }

    pub async fn close_all(&mut self) {
        let ids = self.sessions.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            let _ = self.close(&id).await;
        }
    }
}
