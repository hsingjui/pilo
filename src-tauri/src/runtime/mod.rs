mod chat_sessions;
pub mod commands;
mod credentials;
mod events;
mod git;
mod parallel;
mod pi_events;
mod preview;
pub mod project;
mod remote_fs;
pub(crate) mod server_client;
mod server_deploy;
mod server_pi;
mod session_history;
mod session_index;
mod session_snapshot;
mod session_watcher;
#[allow(dead_code)]
pub(crate) mod ssh;
mod storage;
mod terminal;
#[allow(dead_code)]
mod wsl;

use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::Mutex;

use chat_sessions::ChatSessions;
use parallel::ParallelAgentManager;
use preview::PreviewManager;
use server_client::ServerManager;
use server_pi::ServerPiSession;
use session_history::SessionHistoryCache;
use session_index::BackgroundSessionIndexManager;
use session_watcher::SessionWatcherManager;
use terminal::TerminalManager;

pub struct PiloRuntime {
    pub(crate) chat_sessions: ChatSessions,
    pub(crate) project_pi_session: Mutex<ServerPiSession>,
    pub(crate) parallel_agents: Mutex<ParallelAgentManager>,
    pub(crate) previews: Mutex<PreviewManager>,
    pub(crate) servers: Arc<ServerManager>,
    pub(crate) background_session_index: Arc<StdMutex<BackgroundSessionIndexManager>>,
    pub(crate) session_history_cache: Mutex<SessionHistoryCache>,
    pub(crate) session_watchers: Mutex<SessionWatcherManager>,
    pub(crate) terminals: Mutex<TerminalManager>,
}

impl Default for PiloRuntime {
    fn default() -> Self {
        Self {
            chat_sessions: ChatSessions::default(),
            project_pi_session: Mutex::new(ServerPiSession::default()),
            parallel_agents: Mutex::new(ParallelAgentManager::default()),
            previews: Mutex::new(PreviewManager::default()),
            servers: Arc::new(ServerManager::default()),
            background_session_index: Arc::new(StdMutex::new(
                BackgroundSessionIndexManager::default(),
            )),
            session_history_cache: Mutex::new(SessionHistoryCache::default()),
            session_watchers: Mutex::new(SessionWatcherManager::default()),
            terminals: Mutex::new(TerminalManager::default()),
        }
    }
}

pub(crate) fn print_askpass_password_from_environment() -> bool {
    ssh::print_askpass_password_from_environment()
}
