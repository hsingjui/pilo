#[cfg(feature = "tauri")]
mod appearance;
#[cfg(feature = "tauri")]
mod cache_keep_alive;
#[cfg(feature = "tauri")]
mod chat_service;
#[cfg(feature = "tauri")]
mod chat_sessions;
#[cfg(feature = "tauri")]
pub mod commands;
mod connection_diagnostics;
#[cfg(feature = "tauri")]
mod connection_models;
mod connections;
#[cfg(feature = "tauri")]
mod control;
mod credentials;
pub(crate) mod debug_trace;
#[cfg(feature = "tauri")]
pub(crate) mod desktop_startup;
pub(crate) mod events;
#[cfg(feature = "tauri")]
mod file_links;
#[cfg(feature = "tauri")]
mod git;
pub(crate) mod handle;
pub(crate) mod host_events;
pub(crate) mod host_paths;
pub(crate) use handle::Runtime;
#[cfg(feature = "tauri")]
mod next_prompt;
pub(crate) mod notifications;
#[cfg(feature = "tauri")]
pub mod nsh_spike;
#[cfg(feature = "tauri")]
mod parallel;
mod pi_event_adapters;
mod pi_events;
#[cfg(feature = "tauri")]
mod pi_oneshot;
#[cfg(feature = "tauri")]
mod pi_workspace;
mod preferences;
#[cfg(feature = "tauri")]
mod preview;
pub mod project;
mod project_api;
#[cfg(feature = "tauri")]
mod project_opener;
#[cfg(feature = "tauri")]
mod prompt_enhancement;
#[cfg(feature = "tauri")]
mod remote;
#[cfg(feature = "tauri")]
mod remote_fs;
#[cfg(feature = "tauri")]
mod runtime_api;
#[cfg(feature = "tauri")]
pub(crate) mod server_client;
mod server_deploy;
#[cfg(feature = "tauri")]
mod server_pi;
#[cfg(feature = "tauri")]
mod server_pi_events;
mod session_activity;
#[cfg(feature = "tauri")]
mod session_history;
#[cfg(feature = "tauri")]
mod session_index;
mod session_snapshot;
mod session_watcher;
#[allow(dead_code)]
pub(crate) mod ssh;
pub(crate) mod storage;
pub(crate) mod tasks;
mod terminal;
mod token_usage;
#[allow(dead_code)]
mod wsl;

#[cfg(feature = "tauri")]
use std::sync::{Arc, Mutex as StdMutex};

use tokio::process::Command;
#[cfg(feature = "tauri")]
use tokio::sync::Mutex;

#[cfg(feature = "tauri")]
use chat_sessions::ChatSessions;
pub(crate) use events::RuntimeEventBus;
#[cfg(feature = "tauri")]
use parallel::ParallelAgentManager;
#[cfg(feature = "tauri")]
use preview::PreviewManager;
#[cfg(feature = "tauri")]
pub(crate) use remote::RemoteServerManager;
#[cfg(feature = "tauri")]
use server_client::ServerManager;
#[cfg(feature = "tauri")]
pub(crate) use server_deploy::{initialize_local_server_binary, initialize_server_resource_dir};
#[cfg(feature = "tauri")]
use server_pi::ServerPiSession;
#[cfg(feature = "tauri")]
use session_history::SessionHistoryCache;
#[cfg(feature = "tauri")]
use session_index::BackgroundSessionIndexManager;
#[cfg(feature = "tauri")]
use session_watcher::SessionWatcherManager;
#[cfg(feature = "tauri")]
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

#[cfg(feature = "tauri")]
#[derive(Clone, Default)]
pub struct PiloRuntime(Arc<PiloRuntimeState>);

#[cfg(feature = "tauri")]
impl std::ops::Deref for PiloRuntime {
    type Target = PiloRuntimeState;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[cfg(feature = "tauri")]
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

#[cfg(feature = "tauri")]
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
