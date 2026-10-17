mod desktop_notifications;
mod desktop_shortcut;
mod desktop_tray;
mod desktop_window;
mod domain;
mod runtime;

use desktop_notifications::{
    initialize_macos_notification_application, initialize_windows_notification_application,
    send_macos_desktop_notification, send_windows_desktop_notification,
};
use desktop_tray::desktop_tray_set_labels;
use desktop_window::desktop_open_devtools;
use runtime::desktop_startup::{AUTOSTART_ARG, desktop_autostart_get, desktop_autostart_set};
use runtime::{
    PiloRuntime,
    commands::{
        cache_keep_alive_settings_list, cache_keep_alive_settings_set, chat_session_detach,
        chat_session_prepare, chat_session_send_rpc, chat_session_start, chat_session_state,
        chat_session_states, chat_session_stop, connection_fs_read_dir, connection_health_get,
        connection_naming_model_get, connection_naming_model_list, connection_naming_model_set,
        connection_pi_probe, connection_settings_update, connection_shown_in_home_set,
        local_connection_get, local_connection_test, local_pick_project_directory,
        next_prompt_request, next_prompt_settings_get, next_prompt_settings_set,
        parallel_agent_create, parallel_agent_list, parallel_agent_remove, parallel_agent_send,
        parallel_agent_stop, project_add, project_chat_file_remove, project_chat_file_upload,
        project_discover, project_fs_mkdir, project_fs_read_dir, project_fs_read_file,
        project_fs_read_image, project_fs_remove, project_fs_rename, project_fs_search,
        project_fs_stat, project_fs_write_file, project_git_diff, project_git_status, project_list,
        project_mcp_server_approve, project_model_cache_list, project_model_cache_set,
        project_model_scope_get, project_model_scope_set, project_open_in_zed_wsl,
        project_preview_close, project_preview_open, project_preview_ports, project_refresh,
        project_remove, project_reorder, project_start_pi, project_terminal_open, project_touch,
        prompt_enhance, remote_device_rename, remote_device_revoke, remote_host_state,
        remote_lan_addresses, remote_pairing_regenerate, remote_set_addresses, remote_set_enabled,
        remote_set_port, remote_set_public_base_url, runtime_abort_pi, runtime_get_pi_state,
        runtime_restart_pi, runtime_send_rpc, runtime_stop_pi, runtime_subscribe_events,
        session_delete, session_external_activity, session_generate_title, session_history,
        session_history_image, session_list, session_mark_read, session_read_states,
        session_reconcile, session_search, session_update_ui_state, session_watch_start,
        session_watch_stop, ssh_connection_list, ssh_connection_password_get,
        ssh_connection_remove, ssh_connection_save, ssh_connection_test, ssh_connection_test_draft,
        system_font_families, terminal_close, terminal_resize, terminal_write, theme_settings_get,
        theme_settings_set, wsl_connection_list, wsl_connection_remove, wsl_connection_save,
        wsl_connection_test, wsl_list_distributions,
    },
};
use std::{fs::OpenOptions, io::Write};

pub fn handle_ssh_askpass() -> bool {
    runtime::print_askpass_password_from_environment()
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
    let context = tauri::generate_context!();
    #[cfg(target_os = "linux")]
    // GDK uses the program name as the Wayland app_id when GTK application
    // registration is disabled. Match Tauri's case-sensitive desktop filename
    // (e.g. Pilo.desktop), without making the app single-instance on D-Bus.
    glib::set_prgname(context.config().product_name.as_deref());

    // 0 = running, 1 = cleaning up, 2 = ready to leave the event loop.
    let exiting = std::sync::Arc::new(std::sync::atomic::AtomicU8::new(0));
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A repeated login launch must not pull an already-running app to the foreground.
            if !args.iter().any(|arg| arg == AUTOSTART_ARG)
                && let Err(error) = desktop_window::show_main(app)
            {
                log::error!(target: "desktop", "failed to restore existing instance: {error}");
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
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
                            // Keep WebView runtime failures in file logs only: forwarding
                            // them to a broken WebView creates a log/eval feedback loop.
                            !metadata
                                .target()
                                .starts_with(tauri_plugin_log::WEBVIEW_TARGET)
                                && !metadata.target().starts_with("tauri_runtime_wry")
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
                .with_state_flags(desktop_window::persisted_state_flags())
                // Restore manually after applying platform decorations, then
                // validate bounds before showing the main window.
                .skip_initial_state("main")
                // 会话窗口（`session-*`）由前端每次居中创建，不参与状态持久化：
                // 否则插件会在创建后恢复上次位置/尺寸，看起来像「先居中再跳走」。
                .with_filter(|label| !label.starts_with("session-"))
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new()
            .app_name(if cfg!(debug_assertions) { "Pilo Dev" } else { "Pilo" })
            .arg(AUTOSTART_ARG)
            .build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PiloRuntime::default())
        .manage(runtime::RuntimeEventBus::default())
        .manage(runtime::RemoteServerManager::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            desktop_open_devtools,
            desktop_autostart_get,
            desktop_autostart_set,
            desktop_tray_set_labels,
            desktop_tray::desktop_exit_on_close_get,
            desktop_tray::desktop_exit_on_close_set,
            desktop_shortcut::desktop_shortcut_get,
            desktop_shortcut::desktop_shortcut_set,
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
            connection_shown_in_home_set,
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
            project_open_in_zed_wsl,
            project_model_cache_list,
            project_model_cache_set,
            project_model_scope_get,
            project_model_scope_set,
            cache_keep_alive_settings_list,
            cache_keep_alive_settings_set,
            next_prompt_settings_get,
            next_prompt_settings_set,
            next_prompt_request,
            prompt_enhance,
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
            project_fs_read_image,
            project_fs_write_file,
            project_chat_file_upload,
            project_chat_file_remove,
            project_fs_stat,
            project_fs_mkdir,
            project_fs_rename,
            project_fs_remove,
            project_fs_search,
            project_mcp_server_approve,
            session_list,
            session_read_states,
            session_mark_read,
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
            remote_lan_addresses,
            remote_set_enabled,
            remote_set_port,
            remote_set_public_base_url,
            remote_set_addresses,
            remote_pairing_regenerate,
            remote_device_revoke,
            remote_device_rename,
            system_font_families,
            theme_settings_get,
            theme_settings_set,
        ])
        .on_window_event(|window, event| {
            desktop_tray::handle_window_event(window, event);
            if matches!(event, tauri::WindowEvent::Destroyed) {
                use tauri::Manager;
                window
                    .state::<runtime::RuntimeEventBus>()
                    .unsubscribe(window.label());
            }
        })
        .setup(|app| {
            use tauri::Manager;

            runtime::initialize_server_resource_dir(app.path().resource_dir()?);
            initialize_macos_notification_application(app);
            initialize_windows_notification_application(app);
            app.state::<runtime::RuntimeEventBus>()
                .initialize_session_reads(app.handle())?;
            if let Err(error) = desktop_shortcut::install(app.handle()) {
                log::error!(target: "desktop", "global show shortcut unavailable: {error}");
            }
            if let Err(error) = desktop_tray::create(app.handle()) {
                // Never strand a silent launch when the OS has no usable tray.
                log::error!(target: "desktop", "failed to create tray; keeping window visible: {error}");
            }
            let mode = runtime::desktop_startup::saved_mode(app.handle()).unwrap_or_else(|error| {
                log::error!(target: "desktop", "failed to load startup mode: {error}");
                domain::AutostartMode::default()
            });
            let start_hidden = mode.starts_hidden(
                std::env::args_os().any(|arg| arg == AUTOSTART_ARG),
                desktop_tray::available(app.handle()),
            );
            #[cfg(target_os = "macos")]
            app.set_activation_policy(if start_hidden {
                tauri::ActivationPolicy::Accessory
            } else {
                tauri::ActivationPolicy::Regular
            });
            desktop_window::create_main_window(app, start_hidden)?;
            app.state::<PiloRuntime>().chat_sessions.start_idle_reaper();

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
        .build(context)
        .expect("error while building tauri application")
        .run(move |app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = &event
                && let Err(error) = desktop_window::show_main(app) {
                log::error!(target: "desktop", "failed to reopen main window: {error}");
            }
            // Keep the event loop alive for bounded async teardown. Tray Quit uses
            // exit(0); the second exit(0), after cleanup, is allowed through.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event
                && (code.is_none() || code == Some(0))
            {
                use tauri::Manager;
                if exiting.load(std::sync::atomic::Ordering::SeqCst) == 2 && code == Some(0) {
                    return;
                }
                api.prevent_exit();
                if exiting.compare_exchange(0, 1, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst).is_err() {
                    return;
                }
                let exiting = std::sync::Arc::clone(&exiting);
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
                    };
                    if tokio::time::timeout(std::time::Duration::from_secs(5), teardown)
                        .await
                        .is_err()
                    {
                        log::warn!(target: "shutdown", "graceful shutdown timed out; stopping servers");
                    }
                    // Always close server stdin, even when chat/terminal cleanup timed out.
                    log::info!(target: "shutdown", "servers: stopping");
                    runtime.servers.stop_all().await;
                    log::info!(target: "shutdown", "teardown complete");
                    // macOS 只有在事件循环正常退出时才会通知 LaunchServices/Dock
                    // 注销应用；从工作线程直接 `std::process::exit` 会让 Dock 残留图标
                    // （表现为「退出后仍在后台运行」）。让 Tauri 走一遍 `RunEvent::Exit`
                    // 的正规退出流程：`exit(0)` 产生的是 `code = Some(0)`，上面的
                    // `prevent_exit` 分支不会再拦截，事件循环随即退出并触发清理。
                    log::info!(target: "shutdown", "exiting process");
                    exiting.store(2, std::sync::atomic::Ordering::SeqCst);
                    handle.exit(0);
                    // Windows release 下 `RequestExit` 消息偶发不被处理（见上方注释），
                    // 兜底强制退出，避免残留进程。
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    log::warn!(target: "shutdown", "exit request not processed; forcing exit");
                    std::process::exit(0);
                });
            }
        });
}
