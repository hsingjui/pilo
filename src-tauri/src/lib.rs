mod domain;
mod runtime;

use runtime::{
    commands::{
        local_probe_connection, local_start_pi, runtime_abort_pi, runtime_get_pi_state,
        runtime_restart_pi, runtime_send_rpc, runtime_spawn_pi, runtime_stop_pi, session_list,
        session_reconcile, session_update_ui_state, ssh_probe_connection, ssh_start_pi,
        workspace_add, workspace_discover, workspace_list, workspace_refresh, workspace_remove,
        workspace_start_pi, workspace_touch, wsl_list_distributions, wsl_probe_connection,
        wsl_start_pi,
    },
    PiloRuntime,
};
use tauri_plugin_window_state::StateFlags;

fn persisted_window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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
            local_probe_connection,
            local_start_pi,
            wsl_list_distributions,
            wsl_probe_connection,
            wsl_start_pi,
            ssh_probe_connection,
            ssh_start_pi,
            workspace_list,
            workspace_add,
            workspace_refresh,
            workspace_touch,
            workspace_remove,
            workspace_discover,
            session_list,
            session_reconcile,
            session_update_ui_state,
            workspace_start_pi,
            runtime_get_pi_state,
            runtime_spawn_pi,
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

            // 自定义标题栏仅在 Windows 启用；macOS 保留原生窗口装饰
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
