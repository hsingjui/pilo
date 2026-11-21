pub mod appearance;
pub mod bootstrap;
pub mod cache_keep_alive;
mod chat_service;
mod chat_sessions;
mod connection_diagnostics;
mod connection_models;
pub mod connections;
mod control;
mod credentials;
pub mod debug_trace;
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
mod state;
pub mod storage;
pub use state::{PiloRuntime, PiloRuntimeState};
pub mod tasks;
mod terminal;
pub mod token_usage;
pub mod web_assets;
mod wsl;

use tokio::process::Command;

pub(crate) use events::RuntimeEventBus;
mod transcript;
pub(crate) use remote::RemoteServerManager;
pub use server_deploy::initialize_server_resource_dir;
pub use transcript::{TranscriptSnapshot, TranscriptWindow};

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

pub(crate) fn print_askpass_password_from_environment() -> bool {
    ssh::print_askpass_password_from_environment()
}
