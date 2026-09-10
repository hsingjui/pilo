mod domain;
mod runtime;

use runtime::{
    commands::{
        runtime_abort_pi, runtime_get_pi_state, runtime_restart_pi, runtime_send_rpc,
        runtime_spawn_pi, runtime_stop_pi,
    },
    PiloRuntime,
};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(PiloRuntime::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            runtime_get_pi_state,
            runtime_spawn_pi,
            runtime_stop_pi,
            runtime_restart_pi,
            runtime_abort_pi,
            runtime_send_rpc,
        ])
        .setup(|_app| {
            // 自定义标题栏仅在 Windows 启用；macOS 保留原生窗口装饰
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                let window = _app
                    .get_webview_window("main")
                    .expect("main window not found");
                window.set_decorations(false)?;
                window.set_shadow(true)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
