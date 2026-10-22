use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tauri::AppHandle;

use super::{
    RuntimeEventBus,
    events::{RuntimeEvent, RuntimeEventEnvelope},
    storage,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesSnapshot {
    pub revision: u64,
    pub values: Map<String, Value>,
}

pub(crate) fn defaults() -> Map<String, Value> {
    // Keep these defaults and ranges aligned with font-settings / keyboard-shortcuts.
    json!({
        "locale": "en-US", "sendMessageShortcut": "enter",
        "keyboardShortcuts": {
            "new-chat": "mod+n", "toggle-sidebar": "mod+b", "open-settings": "mod+,",
            "open-command-palette": "mod+k", "cycle-model": "mod+shift+m",
            "cycle-scoped-model": "ctrl+p", "focus-composer": "mod+l", "queue-message": "alt+enter"
        },
        "collapseCompletedActivity": true, "collapseLongMessages": true, "showWorkDuration": true,
        "showPluginNotifications": false, "desktopNotifications": false, "developerMode": false,
        "pageFontFamily": "inter", "uiFontSize": 15, "readingFontFamily": "inter", "readingFontSize": 16,
        "codeFontFamily": "jetbrains-mono", "codeFontSize": 14,
        "terminalFontFamily": "jetbrains-mono", "terminalFontSize": 14
    }).as_object().cloned().unwrap_or_default()
}

pub(crate) fn validate(patch: &Map<String, Value>) -> Result<(), String> {
    let defaults = defaults();
    for (key, value) in patch {
        let Some(default) = defaults.get(key) else {
            return Err(format!("unknown preference '{key}'"));
        };
        let valid = match key.as_str() {
            "locale" => matches!(value.as_str(), Some("en-US" | "zh-CN")),
            "sendMessageShortcut" => matches!(value.as_str(), Some("enter" | "mod-enter")),
            "uiFontSize" => value
                .as_f64()
                .is_some_and(|size| (12.0..=18.0).contains(&size)),
            "readingFontSize" => value
                .as_f64()
                .is_some_and(|size| (12.0..=32.0).contains(&size)),
            "codeFontSize" | "terminalFontSize" => value
                .as_f64()
                .is_some_and(|size| (10.0..=24.0).contains(&size)),
            "keyboardShortcuts" => value.as_object().is_some_and(|shortcuts| {
                !shortcuts.is_empty()
                    && shortcuts.iter().all(|(command, value)| {
                        defaults["keyboardShortcuts"].get(command).is_some()
                            && value.as_str().is_some_and(|shortcut| {
                                shortcut.len() <= 128
                                    && !shortcut.chars().any(char::is_control)
                                    && (shortcut.is_empty() || valid_shortcut(shortcut))
                            })
                    })
            }),
            _ if default.is_boolean() => value.is_boolean(),
            _ => value.as_str().is_some_and(|value| {
                !value.trim().is_empty()
                    && value.len() <= 512
                    && !value.chars().any(char::is_control)
            }),
        };
        if !valid {
            return Err(format!("invalid preference '{key}'"));
        }
    }
    Ok(())
}

fn valid_shortcut(shortcut: &str) -> bool {
    crate::desktop_shortcut::validate_application_shortcut(shortcut).is_ok()
}

pub(crate) fn validate_shortcuts(values: &Map<String, Value>, global: &str) -> Result<(), String> {
    let shortcuts = values
        .get("keyboardShortcuts")
        .ok_or("missing keyboard shortcuts")?;
    crate::desktop_shortcut::validate_in_app_shortcut_conflicts(global, shortcuts)?;
    let mut assigned = std::collections::HashSet::new();
    for value in shortcuts
        .as_object()
        .ok_or("invalid keyboard shortcuts")?
        .values()
    {
        let value = value.as_str().ok_or("invalid keyboard shortcut")?;
        if !value.is_empty()
            && !assigned.insert(crate::desktop_shortcut::validate_application_shortcut(
                value,
            )?)
        {
            return Err("conflicting keyboard shortcuts".to_owned());
        }
    }
    Ok(())
}

pub(crate) fn load(app: &AppHandle) -> Result<PreferencesSnapshot, String> {
    storage::get_preferences(&storage::open(app)?)
}

pub(crate) fn save(
    app: &AppHandle,
    events: &RuntimeEventBus,
    mut patch: Map<String, Value>,
    migrate: bool,
) -> Result<PreferencesSnapshot, String> {
    if migrate
        && let Some(shortcuts) = patch
            .get_mut("keyboardShortcuts")
            .and_then(Value::as_object_mut)
    {
        // One incompatible legacy binding must not prevent importing all preferences.
        for binding in shortcuts.values_mut() {
            if !binding
                .as_str()
                .is_some_and(|value| value.is_empty() || valid_shortcut(value))
            {
                *binding = Value::String(String::new());
            }
        }
    }
    validate(&patch)?;
    let snapshot = storage::patch_preferences(&mut storage::open(app)?, patch, migrate)?;
    events.send(RuntimeEventEnvelope::global(
        RuntimeEvent::PreferencesChanged {
            settings: snapshot.clone(),
        },
    ));
    Ok(snapshot)
}
