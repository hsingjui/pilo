use serde::{Deserialize, Serialize};

#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub const NOTIFICATION_OPEN_SESSION_EVENT: &str = "pilo://notification-open-session";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationSessionTarget {
    pub project_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub struct MacOsDesktopNotificationRequest {
    pub title: String,
    pub body: String,
    pub target: Option<DesktopNotificationSessionTarget>,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub struct WindowsDesktopNotificationRequest {
    pub title: String,
    pub body: String,
    pub target: Option<DesktopNotificationSessionTarget>,
}

#[cfg(target_os = "macos")]
pub fn initialize_macos_notification_application(app: &tauri::App) {
    let bundle_identifier = if tauri::is_dev() {
        // A `tauri dev` process is not an installed .app bundle, so LaunchServices
        // cannot resolve Pilo's bundle identifier. The explicit notification icon
        // below still makes the notification visually belong to Pilo in dev mode.
        "com.apple.Terminal"
    } else {
        app.config().identifier.as_str()
    };

    if let Err(error) = mac_notification_sys::set_application(bundle_identifier) {
        eprintln!(
            "[notification] failed to register macOS notification application '{bundle_identifier}': {error}"
        );
    }
}

#[cfg(not(target_os = "macos"))]
pub fn initialize_macos_notification_application(_app: &tauri::App) {}

#[cfg(target_os = "macos")]
fn notification_icon_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;

    if let Ok(resource_dir) = app.path().resource_dir() {
        for name in ["icon.icns", "icon.png"] {
            let candidate = resource_dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    if tauri::is_dev() {
        let candidate = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("icons")
            .join("icon.png");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

#[cfg(target_os = "macos")]
fn focus_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(target_os = "windows")]
fn focus_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(target_os = "windows")]
fn is_installed_windows_app() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(exe_dir) = exe.parent() else {
        return false;
    };
    let path = exe_dir.to_string_lossy().replace('/', "\\");
    !(path.ends_with("\\target\\debug") || path.ends_with("\\target\\release"))
}

#[cfg(target_os = "windows")]
fn windows_notification_icon_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;

    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("icons").join("128x128.png");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    if tauri::is_dev() {
        let candidate = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("icons")
            .join("128x128.png");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

#[tauri::command]
pub fn send_macos_desktop_notification(
    app: tauri::AppHandle,
    request: MacOsDesktopNotificationRequest,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use mac_notification_sys::{Notification, NotificationResponse};
        use tauri::Emitter;

        let icon_path = notification_icon_path(&app);
        std::thread::Builder::new()
            .name("pilo-notification".to_owned())
            .spawn(move || {
                let MacOsDesktopNotificationRequest {
                    title,
                    body,
                    target,
                } = request;
                let icon_path = icon_path.and_then(|path| path.to_str().map(str::to_owned));

                let mut notification = Notification::new();
                notification.title(&title).message(&body).default_sound();
                if let Some(icon_path) = icon_path.as_deref() {
                    notification.app_icon(icon_path);
                }

                if target.is_some() {
                    notification.wait_for_click(true);
                } else {
                    notification.asynchronous(true);
                }

                match notification.send() {
                    Ok(NotificationResponse::Click | NotificationResponse::ActionButton(_)) => {
                        if let Some(target) = target {
                            focus_main_window(&app);
                            if let Err(error) = app.emit(NOTIFICATION_OPEN_SESSION_EVENT, target) {
                                eprintln!(
                                    "[notification] failed to emit notification target: {error}"
                                );
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(error) => {
                        eprintln!("[notification] failed to show macOS notification: {error}");
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, request);
        Err("native macOS notifications are unavailable on this platform".to_owned())
    }
}

#[tauri::command]
pub fn send_windows_desktop_notification(
    app: tauri::AppHandle,
    request: WindowsDesktopNotificationRequest,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Emitter;
        use tauri_winrt_notification::{IconCrop, Toast};

        let WindowsDesktopNotificationRequest {
            title,
            body,
            target,
        } = request;
        let app_id = if is_installed_windows_app() {
            app.config().identifier.as_str()
        } else {
            Toast::POWERSHELL_APP_ID
        };
        let click_app = app.clone();
        let mut toast = Toast::new(app_id)
            .title(&title)
            .text1(&body)
            .on_activated(move |_| {
                focus_main_window(&click_app);
                if let Some(target) = target.clone()
                    && let Err(error) = click_app.emit(NOTIFICATION_OPEN_SESSION_EVENT, target)
                {
                    eprintln!("[notification] failed to emit notification target: {error}");
                }
                Ok(())
            });

        if let Some(icon_path) = windows_notification_icon_path(&app) {
            toast = toast.icon(&icon_path, IconCrop::Square, "Pilo");
        }

        toast.show().map_err(|error| error.to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, request);
        Err("native Windows notifications are unavailable on this platform".to_owned())
    }
}
