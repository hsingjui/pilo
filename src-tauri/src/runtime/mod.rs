mod chat_sessions;
pub mod commands;
mod events;
mod git;
mod parallel;
mod pi_events;
mod preview;
mod remote_fs;
mod server_client;
mod server_pi;
mod session_index;
mod session_snapshot;
mod session_watcher;
#[allow(dead_code)]
mod ssh;
mod storage;
mod terminal;
pub mod workspace;
#[allow(dead_code)]
mod wsl;

use std::sync::Arc;

use tokio::sync::Mutex;

use chat_sessions::ChatSessions;
use parallel::ParallelAgentManager;
use preview::PreviewManager;
use server_client::ServerManager;
use server_pi::ServerPiSession;
use session_watcher::SessionWatcherManager;
use terminal::TerminalManager;

pub struct PiloRuntime {
    pub(crate) chat_sessions: ChatSessions,
    pub(crate) workspace_pi_session: Mutex<ServerPiSession>,
    pub(crate) parallel_agents: Mutex<ParallelAgentManager>,
    pub(crate) previews: Mutex<PreviewManager>,
    pub(crate) servers: Arc<ServerManager>,
    pub(crate) session_watchers: Mutex<SessionWatcherManager>,
    pub(crate) terminals: Mutex<TerminalManager>,
}

impl Default for PiloRuntime {
    fn default() -> Self {
        Self {
            chat_sessions: ChatSessions::default(),
            workspace_pi_session: Mutex::new(ServerPiSession::default()),
            parallel_agents: Mutex::new(ParallelAgentManager::default()),
            previews: Mutex::new(PreviewManager::default()),
            servers: Arc::new(ServerManager::default()),
            session_watchers: Mutex::new(SessionWatcherManager::default()),
            terminals: Mutex::new(TerminalManager::default()),
        }
    }
}
