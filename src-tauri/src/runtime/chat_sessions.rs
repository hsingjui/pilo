use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, oneshot};

use crate::domain::Project;

use super::{
    debug_trace::runtime_trace,
    events::{
        PiProcessState, RuntimeEvent, RuntimeEventBus, RuntimeEventEnvelope, RuntimeEventSink,
    },
    server_client::ServerManager,
    server_pi::{PiLaunchOptions, ServerPiSession},
    session_snapshot::PiSessionSnapshot,
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionState {
    pub session_key: String,
    pub project_id: String,
    pub session_path: Option<String>,
    pub prepared: bool,
    pub initialized: bool,
    pub active_turn: bool,
    pub snapshot: PiSessionSnapshot,
}

#[derive(Clone, Debug, Default)]
pub struct ChatSessionLaunch {
    pub session_path: Option<String>,
    pub no_session: bool,
    pub extensions: Vec<String>,
    pub disable_builtin_tools: bool,
    pub disable_extension_discovery: bool,
    pub disable_context_files: bool,
}

struct ChatProcess {
    project_id: String,
    no_session: bool,
    extensions: Vec<String>,
    disable_builtin_tools: bool,
    disable_extension_discovery: bool,
    disable_context_files: bool,
    session: Mutex<ServerPiSession>,
    session_path: Arc<StdMutex<Option<String>>>,
    control_reply: Arc<StdMutex<Option<InitializationReply>>>,
    prepared: AtomicBool,
    initialized: AtomicBool,
    active_turn: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
}

#[derive(Default)]
struct ChatRegistry {
    processes: HashMap<String, Arc<ChatProcess>>,
    // true while stopping, false once closed; re-adding may only reopen a closed project.
    unavailable_projects: HashMap<String, bool>,
    shutting_down: bool,
}

#[derive(Default)]
pub struct ChatSessions {
    registry: Mutex<ChatRegistry>,
}

type InitializationReply = oneshot::Sender<Result<(), String>>;

#[derive(Clone)]
struct ChatEventSink {
    events: RuntimeEventBus,
    session_key: String,
    project_id: String,
    control_reply: Arc<StdMutex<Option<InitializationReply>>>,
    session_path: Arc<StdMutex<Option<String>>>,
    active_turn: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
}

impl RuntimeEventSink for ChatEventSink {
    fn send(&self, event: RuntimeEvent) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        match &event {
            RuntimeEvent::UserMessageStart { .. } | RuntimeEvent::AssistantMessageStart { .. } => {
                self.active_turn.store(true, Ordering::Release);
            }
            RuntimeEvent::AssistantMessageEnd { .. }
            | RuntimeEvent::RuntimeError { .. }
            | RuntimeEvent::ProcessState {
                state: PiProcessState::Failed | PiProcessState::Stopped,
                ..
            } => {
                self.active_turn.store(false, Ordering::Release);
            }
            _ => {}
        }
        if let RuntimeEvent::RpcMessage { message, .. } = &event {
            let response_id = message.get("id").and_then(Value::as_str);
            if message.get("type").and_then(Value::as_str) == Some("response")
                && message.get("command").and_then(Value::as_str) == Some("get_state")
                && message.get("success").and_then(Value::as_bool) == Some(true)
                && response_id != Some("pilo-session-prepare")
                && let Some(path) = message.pointer("/data/sessionFile").and_then(Value::as_str)
            {
                *self
                    .session_path
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(path.to_owned());
            }
            if message.get("type").and_then(Value::as_str) == Some("response")
                && matches!(
                    response_id,
                    Some("pilo-session-prepare") | Some("pilo-session-init")
                )
            {
                if let Some(sender) = self
                    .control_reply
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
        }
        self.events.send(RuntimeEventEnvelope::session(
            self.session_key.clone(),
            self.project_id.clone(),
            event,
        ));
    }
}

impl ChatSessions {
    pub async fn state(&self, session_key: &str) -> Option<ChatSessionState> {
        let process = self
            .registry
            .lock()
            .await
            .processes
            .get(session_key)
            .cloned()?;
        if process.closed.load(Ordering::Acquire) {
            return None;
        }
        let session_path = process
            .session_path
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let snapshot = process.session.lock().await.snapshot();
        Some(ChatSessionState {
            session_key: session_key.to_owned(),
            project_id: process.project_id.clone(),
            session_path,
            prepared: process.prepared.load(Ordering::Acquire),
            initialized: process.initialized.load(Ordering::Acquire),
            active_turn: process.active_turn.load(Ordering::Acquire),
            snapshot,
        })
    }

    pub async fn states(&self) -> Vec<ChatSessionState> {
        let processes = {
            let registry = self.registry.lock().await;
            registry
                .processes
                .iter()
                .map(|(session_key, process)| (session_key.clone(), Arc::clone(process)))
                .collect::<Vec<_>>()
        };
        let mut states = Vec::with_capacity(processes.len());
        for (session_key, process) in processes {
            if process.closed.load(Ordering::Acquire) {
                continue;
            }
            let session_path = process
                .session_path
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone();
            let snapshot = process.session.lock().await.snapshot();
            states.push(ChatSessionState {
                session_key,
                project_id: process.project_id.clone(),
                session_path,
                prepared: process.prepared.load(Ordering::Acquire),
                initialized: process.initialized.load(Ordering::Acquire),
                active_turn: process.active_turn.load(Ordering::Acquire),
                snapshot,
            });
        }
        states
    }

    async fn process(
        &self,
        project: &Project,
        session_key: &str,
        launch: &ChatSessionLaunch,
    ) -> Result<Arc<ChatProcess>, String> {
        if session_key.trim().is_empty() {
            return Err("session key cannot be empty".to_owned());
        }
        let session_path = launch.session_path.as_ref();
        if launch.no_session && session_path.is_some() {
            return Err("temporary session cannot resume a persisted session".to_owned());
        }
        let process = {
            let mut registry = self.registry.lock().await;
            if registry.shutting_down || registry.unavailable_projects.contains_key(&project.id) {
                return Err("project is closing".to_owned());
            }
            Arc::clone(
                registry
                    .processes
                    .entry(session_key.to_owned())
                    .or_insert_with(|| {
                        Arc::new(ChatProcess {
                            project_id: project.id.clone(),
                            no_session: launch.no_session,
                            extensions: launch.extensions.clone(),
                            disable_builtin_tools: launch.disable_builtin_tools,
                            disable_extension_discovery: launch.disable_extension_discovery,
                            disable_context_files: launch.disable_context_files,
                            session: Mutex::new(ServerPiSession::default()),
                            session_path: Arc::new(StdMutex::new(session_path.cloned())),
                            control_reply: Arc::new(StdMutex::new(None)),
                            prepared: AtomicBool::new(false),
                            initialized: AtomicBool::new(false),
                            active_turn: Arc::new(AtomicBool::new(false)),
                            closed: Arc::new(AtomicBool::new(false)),
                        })
                    }),
            )
        };
        if process.project_id != project.id {
            return Err("session belongs to a different project".to_owned());
        }
        if process.no_session != launch.no_session {
            return Err("session persistence mode changed while running".to_owned());
        }
        if process.extensions != launch.extensions {
            return Err("session extensions changed while running".to_owned());
        }
        if process.disable_builtin_tools != launch.disable_builtin_tools
            || process.disable_extension_discovery != launch.disable_extension_discovery
            || process.disable_context_files != launch.disable_context_files
        {
            return Err("session Pi isolation mode changed while running".to_owned());
        }
        if let Some(path) = session_path {
            let mut current = process
                .session_path
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if current.is_none() {
                *current = Some(path.clone());
            }
        }
        Ok(process)
    }

    async fn spawn_if_needed(
        process: &Arc<ChatProcess>,
        session: &mut ServerPiSession,
        servers: Arc<ServerManager>,
        app: AppHandle,
        project: &Project,
        session_key: &str,
    ) -> Result<PiSessionSnapshot, String> {
        let snapshot = session.snapshot();
        if snapshot.state == PiProcessState::Running {
            return Ok(snapshot);
        }
        process.prepared.store(false, Ordering::Release);
        process.initialized.store(false, Ordering::Release);
        *process
            .control_reply
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        let session_path = process
            .session_path
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        runtime_trace(
            "chat.spawn.begin",
            Some(session_key),
            None,
            json!({
                "projectId": project.id,
                "hasSessionPath": session_path.is_some(),
                "noSession": process.no_session,
            }),
        );
        let result = session
            .spawn(
                servers,
                ChatEventSink {
                    events: app.state::<RuntimeEventBus>().inner().clone(),
                    session_key: session_key.to_owned(),
                    project_id: project.id.clone(),
                    control_reply: Arc::clone(&process.control_reply),
                    session_path: Arc::clone(&process.session_path),
                    active_turn: Arc::clone(&process.active_turn),
                    closed: Arc::clone(&process.closed),
                },
                project,
                PiLaunchOptions {
                    session_path,
                    no_session: process.no_session,
                    extensions: process.extensions.clone(),
                    disable_builtin_tools: process.disable_builtin_tools,
                    disable_extension_discovery: process.disable_extension_discovery,
                    disable_context_files: process.disable_context_files,
                    ..PiLaunchOptions::default()
                },
            )
            .await;
        match &result {
            Ok(snapshot) => runtime_trace(
                "chat.spawn.end",
                Some(session_key),
                session.stream_id(),
                json!({
                    "ok": true,
                    "generation": snapshot.generation,
                    "state": snapshot.state,
                }),
            ),
            Err(error) => runtime_trace(
                "chat.spawn.end",
                Some(session_key),
                session.stream_id(),
                json!({ "ok": false, "error": error }),
            ),
        }
        result
    }

    async fn wait_for_control_response(
        process: &Arc<ChatProcess>,
        session: &ServerPiSession,
        command: Value,
    ) -> Result<(), String> {
        let (sender, response) = oneshot::channel();
        *process
            .control_reply
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(sender);
        let result = async {
            session.send_rpc(command).await?;
            tokio::time::timeout(Duration::from_secs(30), response)
                .await
                .map_err(|_| "Pi session initialization timed out".to_owned())?
                .map_err(|_| "Pi session initialization channel closed".to_owned())?
        }
        .await;
        if result.is_err() {
            *process
                .control_reply
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = None;
        }
        result
    }

    pub async fn prepare(
        &self,
        servers: Arc<ServerManager>,
        app: AppHandle,
        project: Project,
        session_key: String,
        launch: ChatSessionLaunch,
    ) -> Result<PiSessionSnapshot, String> {
        runtime_trace(
            "chat.prepare.begin",
            Some(&session_key),
            None,
            json!({
                "hasSessionPath": launch.session_path.is_some(),
                "noSession": launch.no_session,
            }),
        );
        let process = self.process(&project, &session_key, &launch).await?;
        let mut session = process.session.lock().await;
        if process.closed.load(Ordering::Acquire) {
            return Err("project is closing".to_owned());
        }
        let snapshot =
            Self::spawn_if_needed(&process, &mut session, servers, app, &project, &session_key)
                .await?;
        if process.prepared.load(Ordering::Acquire) {
            runtime_trace(
                "chat.prepare.end",
                Some(&session_key),
                session.stream_id(),
                json!({ "ok": true, "cached": true, "generation": snapshot.generation }),
            );
            return Ok(snapshot);
        }
        let prepared = Self::wait_for_control_response(
            &process,
            &session,
            serde_json::json!({ "id": "pilo-session-prepare", "type": "get_state" }),
        )
        .await;
        if let Err(error) = prepared {
            runtime_trace(
                "chat.prepare.end",
                Some(&session_key),
                session.stream_id(),
                json!({ "ok": false, "error": error }),
            );
            process.prepared.store(false, Ordering::Release);
            process.initialized.store(false, Ordering::Release);
            let _ = session.stop().await;
            return Err(error);
        }
        process.prepared.store(true, Ordering::Release);
        if launch.session_path.is_some() || process.no_session {
            // Pi was launched with --session, so the readiness get_state also proves
            // the requested historical session is fully loaded. --no-session starts
            // with an in-memory session that needs no additional new_session RPC.
            process.initialized.store(true, Ordering::Release);
        }
        let snapshot = session.snapshot();
        runtime_trace(
            "chat.prepare.end",
            Some(&session_key),
            session.stream_id(),
            json!({ "ok": true, "cached": false, "generation": snapshot.generation }),
        );
        Ok(snapshot)
    }

    pub async fn ensure(
        &self,
        servers: Arc<ServerManager>,
        app: AppHandle,
        project: Project,
        session_key: String,
        launch: ChatSessionLaunch,
    ) -> Result<PiSessionSnapshot, String> {
        runtime_trace(
            "chat.ensure.begin",
            Some(&session_key),
            None,
            json!({
                "hasSessionPath": launch.session_path.is_some(),
                "noSession": launch.no_session,
            }),
        );
        let process = self.process(&project, &session_key, &launch).await?;
        let mut session = process.session.lock().await;
        if process.closed.load(Ordering::Acquire) {
            return Err("project is closing".to_owned());
        }
        let snapshot =
            Self::spawn_if_needed(&process, &mut session, servers, app, &project, &session_key)
                .await?;
        if process.initialized.load(Ordering::Acquire) {
            runtime_trace(
                "chat.ensure.end",
                Some(&session_key),
                session.stream_id(),
                json!({ "ok": true, "cached": true, "generation": snapshot.generation }),
            );
            return Ok(snapshot);
        }
        let resume_path = process
            .session_path
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let command = if launch.session_path.is_some() {
            serde_json::json!({ "id": "pilo-session-init", "type": "get_state" })
        } else {
            match resume_path {
                Some(path) => {
                    serde_json::json!({ "id": "pilo-session-init", "type": "switch_session", "sessionPath": path })
                }
                None => serde_json::json!({ "id": "pilo-session-init", "type": "new_session" }),
            }
        };
        let initialized = Self::wait_for_control_response(&process, &session, command).await;
        if let Err(error) = initialized {
            runtime_trace(
                "chat.ensure.end",
                Some(&session_key),
                session.stream_id(),
                json!({ "ok": false, "error": error }),
            );
            process.prepared.store(false, Ordering::Release);
            process.initialized.store(false, Ordering::Release);
            let _ = session.stop().await;
            return Err(error);
        }
        process.prepared.store(true, Ordering::Release);
        process.initialized.store(true, Ordering::Release);
        let snapshot = session.snapshot();
        runtime_trace(
            "chat.ensure.end",
            Some(&session_key),
            session.stream_id(),
            json!({ "ok": true, "cached": false, "generation": snapshot.generation }),
        );
        Ok(snapshot)
    }

    pub async fn send(&self, session_key: &str, command: Value) -> Result<(), String> {
        let command_type = command
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let command_id = command.get("id").and_then(Value::as_str).map(str::to_owned);
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
            return Err("project is closing".to_owned());
        }
        runtime_trace(
            "chat.send.begin",
            Some(session_key),
            session.stream_id(),
            json!({ "command": command_type, "id": command_id }),
        );
        let result = session.send_rpc(command).await;
        runtime_trace(
            "chat.send.end",
            Some(session_key),
            session.stream_id(),
            json!({
                "command": command_type,
                "id": command_id,
                "ok": result.is_ok(),
                "error": result.as_ref().err(),
            }),
        );
        result
    }

    pub async fn stop(&self, session_key: &str, reason: Option<&str>) -> Result<(), String> {
        let process = {
            let mut registry = self.registry.lock().await;
            registry.processes.remove(session_key)
        };
        let Some(process) = process else {
            runtime_trace(
                "chat.stop",
                Some(session_key),
                None,
                json!({ "found": false, "reason": reason }),
            );
            return Ok(());
        };
        process.closed.store(true, Ordering::Release);
        let mut session = process.session.lock().await;
        runtime_trace(
            "chat.stop.begin",
            Some(session_key),
            session.stream_id(),
            json!({
                "found": true,
                "reason": reason,
                "prepared": process.prepared.load(Ordering::Acquire),
                "initialized": process.initialized.load(Ordering::Acquire),
                "activeTurn": process.active_turn.load(Ordering::Acquire),
                "hasSessionPath": process
                    .session_path
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .is_some(),
            }),
        );
        let result = session.stop().await;
        runtime_trace(
            "chat.stop.end",
            Some(session_key),
            session.stream_id(),
            json!({
                "ok": result.is_ok(),
                "reason": reason,
                "error": result.as_ref().err(),
            }),
        );
        result?;
        Ok(())
    }

    pub async fn detach(&self, session_key: &str, reason: Option<&str>) -> Result<(), String> {
        let process = {
            let mut registry = self.registry.lock().await;
            registry.processes.remove(session_key)
        };
        let Some(process) = process else {
            runtime_trace(
                "chat.detach",
                Some(session_key),
                None,
                json!({ "found": false, "reason": reason }),
            );
            return Ok(());
        };

        process.closed.store(true, Ordering::Release);
        let detached_session_key = session_key.to_owned();
        let detached_reason = reason.map(str::to_owned);
        runtime_trace(
            "chat.detach",
            Some(session_key),
            None,
            json!({ "found": true, "reason": reason }),
        );

        tokio::spawn(async move {
            let mut session = process.session.lock().await;
            runtime_trace(
                "chat.detach.stop.begin",
                Some(&detached_session_key),
                session.stream_id(),
                json!({ "reason": detached_reason }),
            );
            let result = session.stop().await;
            runtime_trace(
                "chat.detach.stop.end",
                Some(&detached_session_key),
                session.stream_id(),
                json!({
                    "ok": result.is_ok(),
                    "reason": detached_reason,
                    "error": result.as_ref().err(),
                }),
            );
        });

        Ok(())
    }

    pub async fn open_project(&self, project_id: &str) -> Result<(), String> {
        let mut registry = self.registry.lock().await;
        if registry.shutting_down || registry.unavailable_projects.get(project_id) == Some(&true) {
            return Err("project is still closing".to_owned());
        }
        registry.unavailable_projects.remove(project_id);
        Ok(())
    }

    pub async fn stop_project(&self, project_id: &str) -> Result<(), String> {
        let processes = {
            let mut registry = self.registry.lock().await;
            registry
                .unavailable_projects
                .insert(project_id.to_owned(), true);
            registry
                .processes
                .values()
                .filter(|process| process.project_id == project_id)
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
            .retain(|_, process| process.project_id != project_id);
        registry
            .unavailable_projects
            .insert(project_id.to_owned(), false);
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
