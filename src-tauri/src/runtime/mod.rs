pub mod appearance;
pub mod cache_keep_alive;
mod chat_service;
mod chat_sessions;
#[cfg(feature = "tauri")]
pub mod commands;
mod connection_diagnostics;
mod connection_models;
pub mod connections;
mod control;
mod credentials;
pub mod debug_trace;
#[cfg(feature = "tauri")]
pub(crate) mod desktop_startup;
pub mod events;
pub mod file_links;
mod git;
pub mod handle;
pub mod host_events;
pub mod host_paths;
pub use handle::Runtime;
pub mod next_prompt;
pub mod notifications;
mod parallel;
mod pi_event_adapters;
mod pi_events;
mod pi_oneshot;
mod pi_workspace;
pub mod preferences;
mod preview;
pub mod project;
pub mod project_api;
pub mod project_opener;
pub mod prompt_enhancement;
pub mod remote;
mod remote_fs;
pub mod runtime_api;
pub(crate) mod server_client;
pub(crate) mod server_deploy;
mod server_pi;
mod server_pi_events;
mod session_activity;
pub mod session_api;
mod session_history;
mod session_index;
pub mod session_naming;
mod session_snapshot;
mod session_watcher;
pub(crate) mod shortcuts;
pub(crate) mod ssh;
pub mod storage;
pub mod tasks;
mod terminal;
pub mod token_usage;
pub mod web_assets;
mod wsl;

use std::sync::{Arc, Mutex as StdMutex};

use tokio::process::Command;
use tokio::sync::Mutex;

use chat_sessions::ChatSessions;
pub(crate) use events::RuntimeEventBus;
use parallel::ParallelAgentManager;
use preview::PreviewManager;
pub(crate) use remote::RemoteServerManager;
use server_client::ServerManager;
pub use server_deploy::initialize_server_resource_dir;
use server_pi::ServerPiSession;
use session_history::SessionHistoryCache;
use session_index::BackgroundSessionIndexManager;
use session_watcher::SessionWatcherManager;
use terminal::TerminalManager;

/// Pilo 本体是 GUI 程序（没有控制台），Windows 会为它启动的控制台子进程
/// 分配一个新的控制台窗口（即用户看到的"终端"）。用 CREATE_NO_WINDOW
/// 抑制该窗口；非 Windows 平台是空操作。
pub(crate) fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

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

pub(crate) fn print_askpass_password_from_environment() -> bool {
    ssh::print_askpass_password_from_environment()
}
