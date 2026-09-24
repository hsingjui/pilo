mod event_sink;
mod project_lifecycle;
mod session_control;
mod session_start;

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::Serialize;
use tokio::sync::{Mutex, oneshot};

use crate::domain::Project;

use super::{server_pi::ServerPiSession, session_snapshot::PiSessionSnapshot};

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
}
