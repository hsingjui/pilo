use serde::Deserialize;
use tauri::{
    AppHandle, Manager,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::{desktop_shortcut, desktop_window, runtime::storage};

const TRAY_ID: &str = "pilo";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrayLabels {
    show: String,
    hide: String,
    quit: String,
}

fn menu(app: &AppHandle, labels: &TrayLabels) -> tauri::Result<Menu<tauri::Wry>> {
    // Display a hint, not a menu accelerator: the native global shortcut owns it.
    let show_label = if let Some(shortcut) = desktop_shortcut::registered_label(app) {
        format!("{} ({shortcut})", labels.show)
    } else {
        labels.show.clone()
    };
    let show = MenuItem::with_id(app, "tray-show", show_label, true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "tray-hide", &labels.hide, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray-quit", &labels.quit, true, None::<&str>)?;
    Menu::with_items(app, &[&show, &hide, &separator, &quit])
}

pub(crate) fn available(app: &AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

pub(crate) fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = menu(
        app,
        &TrayLabels {
            show: "Show Pilo".into(),
            hide: "Hide to Tray".into(),
            quit: "Quit Pilo".into(),
        },
    )?;
    #[cfg(target_os = "macos")]
    let icon = tauri::include_image!("icons/tray-template.png");
    #[cfg(not(target_os = "macos"))]
    let icon = tauri::include_image!("icons/tray.png");
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(app.config().product_name.as_deref().unwrap_or("Pilo"))
        .menu(&menu)
        // macOS follows menu-bar conventions; Windows left-click restores the window.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| {
            let result = match event.id.as_ref() {
                "tray-show" => desktop_window::show_main(app),
                "tray-hide" => desktop_window::hide_to_tray(app),
                "tray-quit" => {
                    app.exit(0);
                    Ok(())
                }
                _ => Ok(()),
            };
            if let Err(error) = result {
                log::error!(target: "desktop", "tray action failed: {error}");
            }
        })
        .on_tray_icon_event(|tray, event| {
            if !cfg!(target_os = "macos")
                && matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                )
                && let Err(error) = desktop_window::show_main(tray.app_handle())
            {
                log::error!(target: "desktop", "failed to restore main window: {error}");
            }
        })
        .build(app)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn desktop_tray_set_labels(app: AppHandle, labels: TrayLabels) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(
            menu(&app, &labels).map_err(|error| error.to_string())?,
        ))
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn desktop_exit_on_close_get(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        storage::get_exit_on_close(&storage::open(&crate::desktop_paths::from_app(&app)?)?)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn desktop_exit_on_close_set(
    app: AppHandle,
    enabled: bool,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        storage::set_exit_on_close(
            &storage::open(&crate::desktop_paths::from_app(&app)?)?,
            enabled,
        )?;
        Ok(enabled)
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle();
    let result = match event {
        tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
            let exit_on_close = crate::desktop_paths::from_app(app)
                .and_then(|paths| storage::open(&paths))
                .and_then(|db| storage::get_exit_on_close(&db))
                .unwrap_or_else(|error| {
                    log::error!(target: "desktop", "failed to load close behavior: {error}");
                    false
                });
            if exit_on_close {
                api.prevent_close();
                // Keep the window alive until the existing async exit cleanup finishes.
                app.exit(0);
                Ok(())
            } else if available(app) {
                api.prevent_close();
                window.hide().and_then(|()| {
                    #[cfg(target_os = "windows")]
                    window.set_skip_taskbar(true)?;
                    desktop_window::sync_dock_visibility(app, None)
                })
            } else {
                Ok(())
            }
        }
        tauri::WindowEvent::Destroyed => {
            desktop_window::sync_dock_visibility(app, Some(window.label()))
        }
        tauri::WindowEvent::Focused(true) => {
            #[cfg(target_os = "windows")]
            if let Err(error) = window.set_skip_taskbar(false) {
                log::error!(target: "desktop", "failed to restore taskbar entry: {error}");
            }
            desktop_window::sync_dock_visibility(app, None)
        }
        _ => Ok(()),
    };
    if let Err(error) = result {
        log::error!(target: "desktop", "failed to update tray window visibility: {error}");
    }
}
