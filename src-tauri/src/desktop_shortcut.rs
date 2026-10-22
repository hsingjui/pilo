use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcut, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};

use crate::{desktop_window, runtime::storage};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShortcutSettings {
    shortcut: String,
    registered: bool,
}

fn parse(value: &str) -> Result<Shortcut, String> {
    if value.len() > 100 {
        return Err("invalid global shortcut".into());
    }
    let native = value
        .split('+')
        .map(|token| match token {
            "mod" => "CommandOrControl",
            "meta" => "Super",
            other => other,
        })
        .collect::<Vec<_>>()
        .join("+");
    let shortcut: Shortcut = native
        .parse()
        .map_err(|error| format!("invalid global shortcut: {error}"))?;
    let modifiers = Modifiers::CONTROL | Modifiers::SUPER | Modifiers::ALT;
    let function_key = matches!(
        shortcut.key,
        Code::F1
            | Code::F2
            | Code::F3
            | Code::F4
            | Code::F5
            | Code::F6
            | Code::F7
            | Code::F8
            | Code::F9
            | Code::F10
            | Code::F11
            | Code::F12
    );
    if !shortcut.mods.intersects(modifiers) && !function_key {
        return Err("global shortcut requires Ctrl, Command, Alt or a function key".into());
    }
    Ok(shortcut)
}

pub(crate) fn validate_in_app_shortcut_conflicts(
    global: &str,
    shortcuts: &serde_json::Value,
) -> Result<(), String> {
    let global = parse(global)?;
    if shortcuts.as_object().is_some_and(|shortcuts| {
        shortcuts.values().any(|value| {
            value.as_str().is_some_and(|value| {
                !value.is_empty() && parse(value).is_ok_and(|shortcut| shortcut == global)
            })
        })
    }) {
        return Err("desktop shortcut conflicts with an application shortcut".to_owned());
    }
    Ok(())
}

pub(crate) fn validate_application_shortcut(value: &str) -> Result<String, String> {
    if value.len() > 128 || value.chars().any(char::is_control) {
        return Err("invalid application shortcut".into());
    }
    if let Ok(shortcut) = parse(value) {
        return Ok(shortcut.to_string());
    }
    // KeyboardEvent.key can contain printable characters (e.g. Shift+? or Unicode)
    // that the native key-code parser cannot represent. Only parse their modifiers.
    let (modifiers, key) = value
        .rsplit_once('+')
        .ok_or("invalid application shortcut")?;
    let mut chars = key.chars();
    if chars.next().is_none_or(char::is_whitespace) || chars.next().is_some() {
        return Err("invalid application shortcut".into());
    }
    let shortcut = parse(&format!("{modifiers}+a"))?;
    Ok(format!("{}:{}", shortcut.mods.bits(), key.to_lowercase()))
}

pub(crate) fn install(app: &AppHandle) -> Result<(), String> {
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _shortcut, event| {
                // This plugin owns only the show action, including during replacement.
                if event.state() == ShortcutState::Pressed
                    && let Err(error) = desktop_window::show_main(app)
                {
                    log::error!(target: "desktop", "failed to restore main window from shortcut: {error}");
                }
            })
            .build(),
    )
    .map_err(|error| error.to_string())?;
    let saved = storage::get_show_shortcut(&storage::open(app)?)?;
    app.global_shortcut()
        .register(parse(&saved)?)
        .map_err(|error| format!("failed to register {saved}: {error}"))
}

fn load(app: &AppHandle) -> Result<ShortcutSettings, String> {
    let shortcut = storage::get_show_shortcut(&storage::open(app)?)?;
    let registered = app
        .try_state::<GlobalShortcut<tauri::Wry>>()
        .is_some_and(|manager| parse(&shortcut).is_ok_and(|key| manager.is_registered(key)));
    Ok(ShortcutSettings {
        shortcut,
        registered,
    })
}

pub(crate) fn registered_label(app: &AppHandle) -> Option<String> {
    let settings = load(app).ok()?;
    if !settings.registered {
        return None;
    }
    Some(
        settings
            .shortcut
            .split('+')
            .map(|token| match token {
                "mod" if cfg!(target_os = "macos") => "⌘".into(),
                "mod" | "ctrl" => "Ctrl".into(),
                "meta" if cfg!(target_os = "macos") => "⌘".into(),
                "meta" => "Win".into(),
                "alt" if cfg!(target_os = "macos") => "⌥".into(),
                "alt" => "Alt".into(),
                "shift" => "Shift".into(),
                other => other.to_uppercase(),
            })
            .collect::<Vec<String>>()
            .join("+"),
    )
}

// Keep the previous registration until the new combination is accepted by the OS.
fn replace(
    previous: Option<Shortcut>,
    next: Shortcut,
    register: impl Fn(Shortcut) -> Result<(), String>,
    unregister: impl Fn(Shortcut) -> Result<(), String>,
    persist: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if previous == Some(next) {
        return persist();
    }
    register(next)?;
    if let Some(previous) = previous
        && let Err(error) = unregister(previous)
    {
        if let Err(rollback) = unregister(next) {
            log::error!(target: "desktop", "failed to remove replacement shortcut: {rollback}");
        }
        return Err(error);
    }
    if let Err(error) = persist() {
        if let Some(previous) = previous
            && let Err(rollback) = register(previous)
        {
            log::error!(target: "desktop", "failed to restore previous shortcut: {rollback}");
        }
        if let Err(rollback) = unregister(next) {
            log::error!(target: "desktop", "failed to remove unsaved shortcut: {rollback}");
        }
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn desktop_shortcut_get(app: AppHandle) -> Result<ShortcutSettings, String> {
    tauri::async_runtime::spawn_blocking(move || load(&app))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn desktop_shortcut_set(
    app: AppHandle,
    shortcut: String,
) -> Result<ShortcutSettings, String> {
    let next = parse(&shortcut)?;
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app
            .try_state::<GlobalShortcut<tauri::Wry>>()
            .ok_or("global shortcut service unavailable; restart Pilo")?;
        let mut db = storage::open(&app)?;
        // An immediate transaction also serializes changes from multiple windows.
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        validate_in_app_shortcut_conflicts(
            &shortcut,
            &storage::get_preferences(&tx)?.values["keyboardShortcuts"],
        )?;
        let previous = parse(&storage::get_show_shortcut(&tx)?)
            .ok()
            .filter(|key| manager.is_registered(*key));
        replace(
            previous,
            next,
            |key| {
                manager
                    .register(key)
                    .map_err(|error| format!("failed to register shortcut: {error}"))
            },
            |key| manager.unregister(key).map_err(|error| error.to_string()),
            || {
                storage::set_show_shortcut(&tx, &shortcut)?;
                tx.commit().map_err(|error| error.to_string())
            },
        )?;
        Ok(ShortcutSettings {
            shortcut,
            registered: true,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn parses_custom_shortcuts_and_rejects_unsafe_or_invalid_input() {
        assert_eq!(
            parse("mod+alt+p").unwrap(),
            "CommandOrControl+Alt+P".parse().unwrap()
        );
        for value in [
            "ctrl+shift+o",
            "meta+alt+arrowup",
            "f2",
            "mod+space",
            "alt+7",
        ] {
            assert!(parse(value).is_ok(), "{value}");
        }
        for value in [
            "",
            "p",
            "shift+p",
            "ctrl",
            "ctrl+a+b",
            "mod+notakey",
            "mod++p",
        ] {
            assert!(parse(value).is_err(), "{value}");
        }
    }

    #[test]
    fn failed_release_keeps_old_key_and_does_not_persist() {
        let old = parse("mod+alt+p").unwrap();
        let next = parse("mod+shift+o").unwrap();
        let active = RefCell::new(vec![old]);
        let result = replace(
            Some(old),
            next,
            |key| {
                active.borrow_mut().push(key);
                Ok(())
            },
            |key| {
                if key == old {
                    return Err("release failed".into());
                }
                active.borrow_mut().retain(|value| *value != key);
                Ok(())
            },
            || panic!("must not persist when unregister fails"),
        );
        assert!(result.is_err());
        assert_eq!(*active.borrow(), vec![old]);
    }

    #[test]
    fn inactive_saved_key_can_be_replaced_or_rolled_back() {
        let next = parse("mod+shift+o").unwrap();
        for save_failure in [false, true] {
            let active = RefCell::new(Vec::new());
            let result = replace(
                None,
                next,
                |key| {
                    active.borrow_mut().push(key);
                    Ok(())
                },
                |key| {
                    active.borrow_mut().retain(|value| *value != key);
                    Ok(())
                },
                || {
                    if save_failure {
                        Err("disk failure".into())
                    } else {
                        Ok(())
                    }
                },
            );
            assert_eq!(result.is_err(), save_failure);
            assert_eq!(
                *active.borrow(),
                if save_failure { vec![] } else { vec![next] }
            );
        }
    }

    #[test]
    fn replacement_handles_conflicts_persistence_failure_and_same_key() {
        let old = parse("mod+alt+p").unwrap();
        let next = parse("mod+shift+o").unwrap();
        for (conflict, save_failure, same) in [
            (false, false, false),
            (true, false, false),
            (false, true, false),
            (false, false, true),
            (false, true, true),
        ] {
            let active = RefCell::new(vec![old]);
            let saved = RefCell::new(old);
            let next = if same { old } else { next };
            let result = replace(
                Some(old),
                next,
                |key| {
                    if conflict && key == next {
                        return Err("occupied".into());
                    }
                    active.borrow_mut().push(key);
                    Ok(())
                },
                |key| {
                    active.borrow_mut().retain(|value| *value != key);
                    Ok(())
                },
                || {
                    if save_failure {
                        return Err("disk failure".into());
                    }
                    *saved.borrow_mut() = next;
                    Ok(())
                },
            );
            let expected = if conflict || save_failure { old } else { next };
            assert_eq!(result.is_err(), conflict || save_failure);
            assert_eq!(*active.borrow(), vec![expected]);
            assert_eq!(*saved.borrow(), expected);
        }
    }
}
