use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::Mutex;

use super::{
    chat_sessions::ChatSessions, parallel::ParallelAgentManager, preview::PreviewManager,
    server_client::ServerManager, server_pi::ServerPiSession, session_history::SessionHistoryCache,
    session_index::BackgroundSessionIndexManager, session_watcher::SessionWatcherManager,
    terminal::TerminalManager,
};

#[derive(Clone, Default)]
pub struct PiloRuntime(Arc<PiloRuntimeState>);

impl std::ops::Deref for PiloRuntime {
    type Target = PiloRuntimeState;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

pub struct PiloRuntimeState {
    pub(crate) chat_sessions: ChatSessions,
    pub(crate) pi_resource_policy: Arc<tokio::sync::RwLock<()>>,
    pub(crate) project_pi_session: Mutex<ServerPiSession>,
    pub(crate) parallel_agents: Mutex<ParallelAgentManager>,
    pub(crate) previews: Mutex<PreviewManager>,
    pub(crate) servers: Arc<ServerManager>,
    pub(crate) background_session_index: Arc<StdMutex<BackgroundSessionIndexManager>>,
    pub(crate) session_history_cache: Mutex<SessionHistoryCache>,
    pub(crate) session_watchers: Mutex<SessionWatcherManager>,
    pub(crate) terminals: Mutex<TerminalManager>,
}

impl Default for PiloRuntimeState {
    fn default() -> Self {
        Self {
            chat_sessions: ChatSessions::default(),
            pi_resource_policy: Arc::default(),
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
