use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, oneshot};

use crate::domain::Workspace;

use super::{
    events::{PiProcessState, RUNTIME_EVENT_NAME, RuntimeEvent, RuntimeEventSink},
    server_client::ServerManager,
    server_pi::ServerPiSession,
    session_snapshot::PiSessionSnapshot,
};

struct ChatProcess {
    workspace_id: String,
    session: Mutex<ServerPiSession>,
    session_path: Arc<StdMutex<Option<String>>>,
    closed: AtomicBool,
}

#[derive(Default)]
struct ChatRegistry {
    processes: HashMap<String, Arc<ChatProcess>>,
    // true while stopping, false once closed; re-adding may only reopen a closed workspace.
    unavailable_workspaces: HashMap<String, bool>,
    shutting_down: bool,
}

#[derive(Default)]
pub struct ChatSessions {
    registry: Mutex<ChatRegistry>,
}

type InitializationReply = oneshot::Sender<Result<(), String>>;

#[derive(Clone)]
struct ChatEventSink {
    app: AppHandle,
    session_key: String,
    workspace_id: String,
    initialized: Arc<StdMutex<Option<InitializationReply>>>,
    session_path: Arc<StdMutex<Option<String>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatEvent<'a> {
    session_key: &'a str,
    workspace_id: &'a str,
    #[serde(flatten)]
    event: RuntimeEvent,
}

impl RuntimeEventSink for ChatEventSink {
    fn send(&self, event: RuntimeEvent) {
        if let RuntimeEvent::RpcMessage { message, .. } = &event
            && message.get("type").and_then(Value::as_str) == Some("response")
            && message.get("command").and_then(Value::as_str) == Some("get_state")
            && message.get("success").and_then(Value::as_bool) == Some(true)
            && let Some(path) = message.pointer("/data/sessionFile").and_then(Value::as_str)
        {
            *self
                .session_path
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(path.to_owned());
        }
        if let RuntimeEvent::RpcMessage { message, .. } = &event
            && message.get("type").and_then(Value::as_str) == Some("response")
            && message.get("id").and_then(Value::as_str) == Some("pilo-session-init")
        {
            if let Some(sender) = self
                .initialized
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
            {
                let result = if message.get("success").and_then(Value::as_bool) == Some(true)
                    && message.pointer("/data/cancelled").and_then(Value::as_bool) != Some(true)
                {
                    Ok(())
                } else {
                    Err(message
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Pi session initialization was cancelled")
                        .to_owned())
                };
                let _ = sender.send(result);
            }
            return;
        }
        let _ = self.app.emit(
            RUNTIME_EVENT_NAME,
            ChatEvent {
                session_key: &self.session_key,
                workspace_id: &self.workspace_id,
                event,
            },
        );
    }
}

impl ChatSessions {
    pub async fn ensure(
        &self,
        servers: Arc<ServerManager>,
        app: AppHandle,
        workspace: Workspace,
        session_key: String,
        session_path: Option<String>,
    ) -> Result<PiSessionSnapshot, String> {
        if session_key.trim().is_empty() {
            return Err("session key cannot be empty".to_owned());
        }
        let process = {
            let mut registry = self.registry.lock().await;
            if registry.shutting_down || registry.unavailable_workspaces.contains_key(&workspace.id)
            {
                return Err("workspace is closing".to_owned());
            }
            Arc::clone(
                registry
                    .processes
                    .entry(session_key.clone())
                    .or_insert_with(|| {
                        Arc::new(ChatProcess {
                            workspace_id: workspace.id.clone(),
                            session: Mutex::new(ServerPiSession::default()),
                            session_path: Arc::new(StdMutex::new(session_path.clone())),
                            closed: AtomicBool::new(false),
                        })
                    }),
            )
        };
        if process.workspace_id != workspace.id {
            return Err("session belongs to a different workspace".to_owned());
        }
        // Only this session is locked during server startup and Pi initialization.
        let mut session = process.session.lock().await;
        if process.closed.load(Ordering::Acquire) {
            return Err("workspace is closing".to_owned());
        }
        let snapshot = session.snapshot();
        if snapshot.state == PiProcessState::Running {
            return Ok(snapshot);
        }
        if process.closed.load(Ordering::Acquire) {
            return Err("workspace is closing".to_owned());
        }
        let (sender, response) = oneshot::channel();
        let snapshot = session
            .spawn(
                servers,
                ChatEventSink {
                    app,
                    session_key,
                    workspace_id: workspace.id.clone(),
                    initialized: Arc::new(StdMutex::new(Some(sender))),
                    session_path: Arc::clone(&process.session_path),
                },
                &workspace,
                session_path.clone(),
            )
            .await?;
        let resume_path = process
            .session_path
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let command = if session_path.is_some() {
            serde_json::json!({ "id": "pilo-session-init", "type": "get_state" })
        } else {
            match resume_path {
                Some(path) => {
                    serde_json::json!({ "id": "pilo-session-init", "type": "switch_session", "sessionPath": path })
                }
                None => serde_json::json!({ "id": "pilo-session-init", "type": "new_session" }),
            }
        };
        let initialized = async {
            session.send_rpc(command).await?;
            tokio::time::timeout(Duration::from_secs(30), response)
                .await
                .map_err(|_| "Pi session initialization timed out".to_owned())?
                .map_err(|_| "Pi session initialization channel closed".to_owned())?
        }
        .await;
        if let Err(error) = initialized {
            let _ = session.stop().await;
            return Err(error);
        }
        Ok(snapshot)
    }

    pub async fn send(&self, session_key: &str, command: Value) -> Result<(), String> {
        let process = self
            .registry
            .lock()
            .await
            .processes
            .get(session_key)
            .cloned()
            .ok_or_else(|| format!("session '{session_key}' is not running"))?;
        let session = process.session.lock().await;
        if process.closed.load(Ordering::Acquire) {
            return Err("workspace is closing".to_owned());
        }
        session.send_rpc(command).await
    }

    pub async fn open_workspace(&self, workspace_id: &str) -> Result<(), String> {
        let mut registry = self.registry.lock().await;
        if registry.shutting_down
            || registry.unavailable_workspaces.get(workspace_id) == Some(&true)
        {
            return Err("workspace is still closing".to_owned());
        }
        registry.unavailable_workspaces.remove(workspace_id);
        Ok(())
    }

    pub async fn stop_workspace(&self, workspace_id: &str) -> Result<(), String> {
        let processes = {
            let mut registry = self.registry.lock().await;
            registry
                .unavailable_workspaces
                .insert(workspace_id.to_owned(), true);
            registry
                .processes
                .values()
                .filter(|process| process.workspace_id == workspace_id)
                .map(|process| {
                    process.closed.store(true, Ordering::Release);
                    Arc::clone(process)
                })
                .collect::<Vec<_>>()
        };
        for process in processes {
            process.session.lock().await.stop().await?;
        }
        let mut registry = self.registry.lock().await;
        registry
            .processes
            .retain(|_, process| process.workspace_id != workspace_id);
        registry
            .unavailable_workspaces
            .insert(workspace_id.to_owned(), false);
        Ok(())
    }

    pub async fn stop_all(&self) {
        let processes = {
            let mut registry = self.registry.lock().await;
            registry.shutting_down = true;
            registry
                .processes
                .drain()
                .map(|(_, process)| {
                    process.closed.store(true, Ordering::Release);
                    process
                })
                .collect::<Vec<_>>()
        };
        for process in processes {
            let _ = process.session.lock().await.stop().await;
        }
    }
}
