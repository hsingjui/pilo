mod desktop_notifications;
mod domain;
mod runtime;

use desktop_notifications::{
    initialize_macos_notification_application, initialize_windows_notification_application,
    send_macos_desktop_notification, send_windows_desktop_notification,
};
use runtime::{
    PiloRuntime,
    commands::{
        chat_session_detach, chat_session_prepare, chat_session_send_rpc, chat_session_start,
        chat_session_state, chat_session_states, chat_session_stop, connection_fs_read_dir,
        connection_health_get, connection_naming_model_get, connection_naming_model_list,
        connection_naming_model_set, connection_pi_probe, connection_settings_update,
        local_connection_get, local_connection_test, local_pick_project_directory,
        parallel_agent_create, parallel_agent_list, parallel_agent_remove, parallel_agent_send,
        parallel_agent_stop, project_add, project_discover, project_fs_mkdir, project_fs_read_dir,
        project_fs_read_file, project_fs_remove, project_fs_rename, project_fs_search,
        project_fs_stat, project_fs_write_file, project_git_diff, project_git_status, project_list,
        project_model_cache_list, project_model_cache_set, project_preview_close,
        project_preview_open, project_preview_ports, project_refresh, project_remove,
        project_reorder, project_start_pi, project_terminal_open, project_touch,
        remote_device_rename, remote_device_revoke, remote_host_state, remote_pairing_regenerate,
        remote_set_enabled, remote_set_port, remote_set_public_base_url, runtime_abort_pi,
        runtime_get_pi_state, runtime_restart_pi, runtime_send_rpc, runtime_stop_pi,
        runtime_subscribe_events, session_delete, session_external_activity,
        session_generate_title, session_history, session_history_image, session_list,
        session_reconcile, session_search, session_update_ui_state, session_watch_start,
        session_watch_stop, ssh_connection_list, ssh_connection_password_get,
        ssh_connection_remove, ssh_connection_save, ssh_connection_test, ssh_connection_test_draft,
        system_font_families, terminal_close, terminal_resize, terminal_write, wsl_connection_list,
        wsl_connection_remove, wsl_connection_save, wsl_connection_test, wsl_list_distributions,
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

#[tauri::command]
fn debug_runtime_trace_log(payload: &str) -> Result<(), String> {
    runtime::debug_trace::append_frontend_trace(payload)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Guards the exit teardown so a repeated exit request cannot run it twice.
    let exiting = std::sync::atomic::AtomicBool::new(false);
    let builder = tauri::Builder::default().plugin(
        tauri_plugin_log::Builder::new()
            .level(if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            })
            .max_file_size(5 * 1024 * 1024)
            .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(4))
            .target(
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview).filter(
                    |metadata| {
                        !metadata
                            .target()
                            .starts_with(tauri_plugin_log::WEBVIEW_TARGET)
                    },
                ),
            )
            .build(),
    );

    // Embedded WebDriver is opt-in for development: `tauri dev --features webdriver`.
    #[cfg(all(debug_assertions, feature = "webdriver"))]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(persisted_window_state_flags())
                // Pilo removes native decorations on Windows in `setup` below.
                // Restore after that change so the saved client size does not
                // grow by the removed title-bar height on every launch.
                .skip_initial_state("main")
                // 会话窗口（`session-*`）由前端每次居中创建，不参与状态持久化：
                // 否则插件会在创建后恢复上次位置/尺寸，看起来像「先居中再跳走」。
                .with_filter(|label| !label.starts_with("session-"))
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PiloRuntime::default())
        .manage(runtime::RuntimeEventBus::default())
        .manage(runtime::RemoteServerManager::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            debug_chat_performance_log,
            debug_runtime_trace_log,
            send_macos_desktop_notification,
            send_windows_desktop_notification,
            chat_session_prepare,
            chat_session_start,
            chat_session_send_rpc,
            chat_session_state,
            chat_session_states,
            chat_session_stop,
            chat_session_detach,
            connection_health_get,
            connection_naming_model_list,
            connection_naming_model_get,
            connection_naming_model_set,
            connection_pi_probe,
            connection_settings_update,
            local_connection_get,
            ssh_connection_list,
            ssh_connection_password_get,
            ssh_connection_save,
            ssh_connection_remove,
            ssh_connection_test,
            ssh_connection_test_draft,
            wsl_connection_list,
            wsl_connection_save,
            wsl_connection_remove,
            wsl_connection_test,
            local_connection_test,
            wsl_list_distributions,
            project_list,
            project_model_cache_list,
            project_model_cache_set,
            project_add,
            project_refresh,
            project_touch,
            project_reorder,
            project_remove,
            project_discover,
            project_git_status,
            project_git_diff,
            project_terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            parallel_agent_list,
            parallel_agent_create,
            parallel_agent_send,
            parallel_agent_stop,
            parallel_agent_remove,
            project_preview_ports,
            project_preview_open,
            project_preview_close,
            connection_fs_read_dir,
            local_pick_project_directory,
            project_fs_read_dir,
            project_fs_read_file,
            project_fs_write_file,
            project_fs_stat,
            project_fs_mkdir,
            project_fs_rename,
            project_fs_remove,
            project_fs_search,
            session_list,
            session_external_activity,
            session_generate_title,
            session_reconcile,
            session_history,
            session_history_image,
            session_search,
            session_delete,
            session_watch_start,
            session_watch_stop,
            session_update_ui_state,
            project_start_pi,
            runtime_get_pi_state,
            runtime_stop_pi,
            runtime_restart_pi,
            runtime_abort_pi,
            runtime_send_rpc,
            runtime_subscribe_events,
            remote_host_state,
            remote_set_enabled,
            remote_set_port,
            remote_set_public_base_url,
            remote_pairing_regenerate,
            remote_device_revoke,
            remote_device_rename,
            system_font_families,
        ])
        .setup(|app| {
            use tauri::Manager;
            use tauri_plugin_window_state::WindowExt;

            initialize_macos_notification_application(app);
            initialize_windows_notification_application(app);

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
                log::error!(target: "window-state", "failed to restore main window: {error}");
            }

            let remote_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let remote = remote_app.state::<runtime::RemoteServerManager>();
                if let Err(error) = remote.restore(remote_app.clone()).await {
                    log::error!(target: "remote-webui", "failed to restore Remote WebUI: {error}");
                }
            });

            let app_handle = app.handle().clone();
            let servers = std::sync::Arc::clone(&app.state::<PiloRuntime>().servers);
            tauri::async_runtime::spawn(async move {
                let projects = match runtime::project::list(&app_handle) {
                    Ok(projects) => projects,
                    Err(error) => {
                        log::error!(target: "server-prewarm", "failed to load projects: {error}");
                        return;
                    }
                };
                let mut seen_connections = std::collections::HashSet::new();
                for connection in projects
                    .into_iter()
                    .map(|project| project.connection)
                    .filter(|connection| seen_connections.insert(connection.id.clone()))
                {
                    let servers = std::sync::Arc::clone(&servers);
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = servers.client(&connection).await {
                            log::error!(
                                target: "server-prewarm",
                                "failed for connection '{}': {error}",
                                connection.id
                            );
                        }
                    });
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app, event| {
            // Teardown must run while the event loop is still alive. At
            // `RunEvent::Exit` tokio's time driver is no longer pumped, so any
            // timer or unresponsive child wait inside `block_on` parks forever
            // and the app never quits. Intercept the user-initiated exit instead
            // (`ExitRequested` with no exit code fires when the last window
            // closes), keep the loop alive, tear down asynchronously, then exit.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event
                && code.is_none()
                && !exiting.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                use tauri::Manager;
                api.prevent_exit();
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let runtime = handle.state::<PiloRuntime>();
                    let remote = handle.state::<runtime::RemoteServerManager>();
                    // The whole teardown is bounded and always followed by
                    // exit(0): a stuck pilo-server RPC must never keep the app
                    // alive. Logs at each step pinpoint where it stalls.
                    let teardown = async {
                        log::info!(target: "shutdown", "remote webui: stopping");
                        remote.stop().await;
                        log::info!(target: "shutdown", "chat sessions: stopping");
                        runtime.chat_sessions.stop_all().await;
                        log::info!(target: "shutdown", "project pi session: stopping");
                        let _ = runtime.project_pi_session.lock().await.stop().await;
                        log::info!(target: "shutdown", "session watchers: stopping");
                        runtime.session_watchers.lock().await.stop_all().await;
                        log::info!(target: "shutdown", "terminals: closing");
                        runtime.terminals.lock().await.close_all().await;
                        log::info!(target: "shutdown", "servers: stopping");
                        runtime.servers.stop_all().await;
                        log::info!(target: "shutdown", "teardown complete");
                    };
                    if tokio::time::timeout(std::time::Duration::from_secs(5), teardown)
                        .await
                        .is_err()
                    {
                        log::warn!(target: "shutdown", "graceful shutdown timed out; forcing exit");
                    }
                    // `AppHandle::exit` only posts a `RequestExit` message to the
                    // event loop and does not terminate the process itself. If
                    // that message is not processed (observed on Windows release)
                    // the app lingers. Exit the process directly after teardown.
                    // The window-state plugin already saves on close, so nothing
                    // user-visible is lost by skipping the normal teardown events.
                    log::info!(target: "shutdown", "exiting process");
                    std::process::exit(0);
                });
            }
        });
}
