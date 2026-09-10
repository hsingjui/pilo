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
        .invoke_handler(tauri::generate_handler![greet])
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
