mod event_sink;
mod idle_cache;
mod project_lifecycle;
mod session_control;
mod session_start;
mod transcript;
mod turn_projection;

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use pilo_protocol::BuiltinExtension;
use serde::Serialize;
use tokio::sync::{Mutex, oneshot};

use pilo_domain::Project;

use super::{
    events::RuntimeEventBus,
    server_pi::{ServerPiSession, SessionSnapshotReader},
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
    pub compacting: bool,
    pub cache_keep_alive: Option<pilo_domain::CacheKeepAliveStatus>,
    pub snapshot: PiSessionSnapshot,
}

#[derive(Clone, Debug, Default)]
pub struct ChatSessionLaunch {
    pub session_path: Option<String>,
    pub no_session: bool,
    pub extensions: Vec<String>,
    pub builtin_extensions: Vec<BuiltinExtension>,
    pub disable_builtin_tools: bool,
    pub disable_extension_discovery: bool,
    pub disable_context_files: bool,
}

struct ChatProcess {
    events: RuntimeEventBus,
    turn: Arc<turn_projection::SessionTurn>,
    project_id: String,
    no_session: bool,
    extensions: Vec<String>,
    disable_builtin_tools: bool,
    disable_extension_discovery: bool,
    disable_context_files: bool,
    session: Mutex<ServerPiSession>,
    session_path: Arc<StdMutex<Option<String>>>,
    control_reply: Arc<StdMutex<Option<InitializationReply>>>,
    initialization_stderr: Arc<StdMutex<String>>,
    prepared: AtomicBool,
    initialized: AtomicBool,
    active_turn: Arc<AtomicBool>,
    compacting: Arc<AtomicBool>,
    // Owner id of the prompt whose preemptive `active_turn` flag has not been
    // confirmed by a Pi response yet. Used to roll the flag back on a preflight rejection.
    pending_prompt_id: Arc<StdMutex<Option<String>>>,
    closed: Arc<AtomicBool>,
    last_used: AtomicU64,
}

impl ChatProcess {
    fn mark_closed(&self) {
        let mut reply = self
            .control_reply
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.closed.store(true, Ordering::Release);
        if let Some(sender) = reply.take() {
            let _ = sender.send(Err("project is closing".to_owned()));
        }
    }
}

#[derive(Default)]
struct ChatRegistry {
    processes: HashMap<String, Arc<ChatProcess>>,
    snapshots: HashMap<String, SessionSnapshotReader>,
    events: Option<RuntimeEventBus>,
    // true while stopping, false once closed; re-adding may only reopen a closed project.
    unavailable_projects: HashMap<String, bool>,
    shutting_down: bool,
    usage_sequence: u64,
    idle_since: HashMap<String, (u64, std::time::Instant)>,
}

#[derive(Clone, Default)]
pub struct ChatSessions {
    registry: Arc<Mutex<ChatRegistry>>,
}

type InitializationReply = oneshot::Sender<Result<(), String>>;

impl ChatSessions {
    pub async fn state(&self, session_key: &str) -> Option<ChatSessionState> {
        let (process, snapshot_reader) = {
            let registry = self.registry.lock().await;
            (
                registry.processes.get(session_key).cloned()?,
                registry.snapshots.get(session_key).cloned(),
            )
        };
        if process.closed.load(Ordering::Acquire) {
            return None;
        }
        let session_path = process
            .session_path
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let cache_keep_alive = snapshot_reader
            .as_ref()
            .and_then(|reader| reader.cache_keep_alive());
        let snapshot = match snapshot_reader {
            Some(reader) => reader.snapshot(),
            None => process.session.try_lock().ok()?.snapshot(),
        };
        Some(ChatSessionState {
            session_key: session_key.to_owned(),
            project_id: process.project_id.clone(),
            session_path,
            prepared: process.prepared.load(Ordering::Acquire),
            initialized: process.initialized.load(Ordering::Acquire),
            active_turn: process.active_turn.load(Ordering::Acquire),
            compacting: process.compacting.load(Ordering::Acquire),
            cache_keep_alive,
            snapshot,
        })
    }

    pub async fn states(&self) -> Vec<ChatSessionState> {
        let processes = {
            let registry = self.registry.lock().await;
            registry
                .processes
                .iter()
                .map(|(session_key, process)| {
                    (
                        session_key.clone(),
                        Arc::clone(process),
                        registry.snapshots.get(session_key).cloned(),
                    )
                })
                .collect::<Vec<_>>()
        };
        let mut states = Vec::with_capacity(processes.len());
        for (session_key, process, snapshot_reader) in processes {
            if process.closed.load(Ordering::Acquire) {
                continue;
            }
            let session_path = process
                .session_path
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone();
            let cache_keep_alive = snapshot_reader
                .as_ref()
                .and_then(|reader| reader.cache_keep_alive());
            let snapshot = match snapshot_reader {
                Some(reader) => reader.snapshot(),
                None => match process.session.try_lock() {
                    Ok(session) => session.snapshot(),
                    Err(_) => continue,
                },
            };
            states.push(ChatSessionState {
                session_key,
                project_id: process.project_id.clone(),
                session_path,
                prepared: process.prepared.load(Ordering::Acquire),
                initialized: process.initialized.load(Ordering::Acquire),
                active_turn: process.active_turn.load(Ordering::Acquire),
                compacting: process.compacting.load(Ordering::Acquire),
                cache_keep_alive,
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
        events: &RuntimeEventBus,
    ) -> Result<Arc<ChatProcess>, String> {
        if session_key.trim().is_empty() {
            return Err("session key cannot be empty".to_owned());
        }
        let session_path = launch.session_path.as_ref();
        if launch.no_session && session_path.is_some() {
            return Err("temporary session cannot resume a persisted session".to_owned());
        }
        self.prune_idle(session_key).await;
        let process = {
            let mut registry = self.registry.lock().await;
            if registry.shutting_down || registry.unavailable_projects.contains_key(&project.id) {
                return Err("project is closing".to_owned());
            }
            registry.events = Some(events.clone());
            registry.usage_sequence = registry.usage_sequence.saturating_add(1);
            let usage_sequence = registry.usage_sequence;
            let process = if let Some(process) = registry.processes.get(session_key) {
                Arc::clone(process)
            } else {
                let session =
                    ServerPiSession::with_builtin_extensions(launch.builtin_extensions.clone());
                let reader = session.snapshot_reader();
                registry
                    .snapshots
                    .insert(session_key.to_owned(), reader.clone());
                let turn = match project.connection.kind {
                    pilo_domain::ConnectionKind::Local => turn_projection::SessionTurn::new(true),
                    _ => turn_projection::SessionTurn::new_remote(reader),
                };
                let process = Arc::new(ChatProcess {
                    events: events.clone(),
                    turn: Arc::new(turn),
                    project_id: project.id.clone(),
                    no_session: launch.no_session,
                    extensions: launch.extensions.clone(),
                    disable_builtin_tools: launch.disable_builtin_tools,
                    disable_extension_discovery: launch.disable_extension_discovery,
                    disable_context_files: launch.disable_context_files,
                    session: Mutex::new(session),
                    session_path: Arc::new(StdMutex::new(session_path.cloned())),
                    control_reply: Arc::new(StdMutex::new(None)),
                    initialization_stderr: Arc::new(StdMutex::new(String::new())),
                    prepared: AtomicBool::new(false),
                    initialized: AtomicBool::new(false),
                    active_turn: Arc::new(AtomicBool::new(false)),
                    compacting: Arc::new(AtomicBool::new(false)),
                    pending_prompt_id: Arc::new(StdMutex::new(None)),
                    closed: Arc::new(AtomicBool::new(false)),
                    last_used: AtomicU64::new(usage_sequence),
                });
                registry
                    .processes
                    .insert(session_key.to_owned(), Arc::clone(&process));
                process
            };
            process.last_used.store(usage_sequence, Ordering::Release);
            process
        };
        if process.project_id != project.id {
            return Err("session belongs to a different project".to_owned());
        }
        if process.no_session != launch.no_session {
            return Err("session persistence mode changed while running".to_owned());
        }
        if process.session.lock().await.builtin_extensions() != launch.builtin_extensions.as_slice()
        {
            return Err("session builtin extensions changed while running".to_owned());
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
