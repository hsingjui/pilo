mod domain;
mod runtime;

use runtime::{
    PiloRuntime,
    commands::{
        chat_session_send_rpc, chat_session_start, chat_session_stop, local_connection_test,
        parallel_agent_create, parallel_agent_list, parallel_agent_remove, parallel_agent_send,
        parallel_agent_stop, runtime_abort_pi, runtime_get_pi_state, runtime_restart_pi,
        runtime_send_rpc, runtime_stop_pi, session_history, session_list, session_reconcile,
        session_update_ui_state, session_watch_start, session_watch_stop, ssh_connection_list,
        ssh_connection_remove, ssh_connection_save, ssh_connection_test, terminal_close,
        terminal_resize, terminal_write, workspace_add, workspace_discover, workspace_fs_mkdir,
        workspace_fs_read_dir, workspace_fs_read_file, workspace_fs_remove, workspace_fs_rename,
        workspace_fs_search, workspace_fs_stat, workspace_fs_write_file, workspace_git_diff,
        workspace_git_status, workspace_list, workspace_preview_close, workspace_preview_open,
        workspace_preview_ports, workspace_refresh, workspace_remove, workspace_start_pi,
        workspace_terminal_open, workspace_touch, wsl_connection_list, wsl_connection_test,
        wsl_list_distributions,
    },
};
use std::{fs::OpenOptions, io::Write};
use tauri_plugin_window_state::StateFlags;

pub fn handle_ssh_askpass() -> bool {
    runtime::print_askpass_password_from_environment()
}

fn persisted_window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn debug_chat_performance_log(payload: &str) -> Result<(), String> {
    let path = std::env::temp_dir().join("pilo-chat-performance.jsonl");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{payload}").map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(persisted_window_state_flags())
                // Pilo removes native decorations on Windows in `setup` below.
                // Restore after that change so the saved client size does not
                // grow by the removed title-bar height on every launch.
                .skip_initial_state("main")
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(PiloRuntime::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            debug_chat_performance_log,
            chat_session_start,
            chat_session_send_rpc,
            chat_session_stop,
            ssh_connection_list,
            ssh_connection_save,
            ssh_connection_remove,
            ssh_connection_test,
            wsl_connection_list,
            wsl_connection_test,
            local_connection_test,
            wsl_list_distributions,
            workspace_list,
            workspace_add,
            workspace_refresh,
            workspace_touch,
            workspace_remove,
            workspace_discover,
            workspace_git_status,
            workspace_git_diff,
            workspace_terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            parallel_agent_list,
            parallel_agent_create,
            parallel_agent_send,
            parallel_agent_stop,
            parallel_agent_remove,
            workspace_preview_ports,
            workspace_preview_open,
            workspace_preview_close,
            workspace_fs_read_dir,
            workspace_fs_read_file,
            workspace_fs_write_file,
            workspace_fs_stat,
            workspace_fs_mkdir,
            workspace_fs_rename,
            workspace_fs_remove,
            workspace_fs_search,
            session_list,
            session_reconcile,
            session_history,
            session_watch_start,
            session_watch_stop,
            session_update_ui_state,
            workspace_start_pi,
            runtime_get_pi_state,
            runtime_stop_pi,
            runtime_restart_pi,
            runtime_abort_pi,
            runtime_send_rpc,
        ])
        .setup(|app| {
            use tauri::Manager;
            use tauri_plugin_window_state::WindowExt;

            let window = app
                .get_webview_window("main")
                .expect("main window not found");

            // Windows 移除原生装饰、使用前端自绘标题栏；
            // macOS 保留原生红绿灯：tauri.conf.json 的 hiddenTitle + Overlay 隐藏标题栏文本，
            // 内容延伸至窗口顶部（侧边栏贴顶，标题行位于红绿灯右侧）。
            #[cfg(target_os = "windows")]
            {
                window.set_decorations(false)?;
                window.set_shadow(true)?;
            }

            if let Err(error) = window.restore_state(persisted_window_state_flags()) {
                eprintln!("[window-state] failed to restore main window: {error}");
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                let runtime = app.state::<PiloRuntime>();
                tauri::async_runtime::block_on(async {
                    runtime.chat_sessions.stop_all().await;
                    let _ = runtime.workspace_pi_session.lock().await.stop().await;
                    runtime.session_watchers.lock().await.stop_all().await;
                    runtime.terminals.lock().await.close_all().await;
                    runtime.servers.stop_all().await;
                });
            }
        });
}
