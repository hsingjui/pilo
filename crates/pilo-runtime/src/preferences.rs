use super::{Runtime, host_paths::HostPaths};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

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
    // Keep these defaults aligned with font-settings / keyboard-shortcuts.
    json!({
        "locale": "en-US", "sendMessageShortcut": "enter",
        "defaultWorkspaceVisibility": {},
        "keyboardShortcuts": {
            "new-chat": "mod+n", "toggle-sidebar": "mod+b", "open-settings": "mod+,",
            "open-command-palette": "mod+k", "cycle-model": "mod+shift+m",
            "cycle-scoped-model": "ctrl+p", "focus-composer": "mod+l", "queue-message": "alt+enter"
        },
        "collapseCompletedActivity": true, "collapseLongMessages": true, "showWorkDuration": true,
        "showPluginNotifications": false, "desktopNotifications": false, "developerMode": false,
        "pageFontFamily": "system-sans", "uiFontSize": 15, "readingFontFamily": "system-sans", "readingFontSize": 16,
        "codeFontFamily": "system-mono", "codeFontSize": 14,
        "terminalFontFamily": "system-mono", "terminalFontSize": 14
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
            "uiFontSize" | "readingFontSize" | "codeFontSize" | "terminalFontSize" => value
                .as_f64()
                .is_some_and(|size| size.is_finite() && size > 0.0),
            "defaultWorkspaceVisibility" => value.as_object().is_some_and(|connections| {
                connections.len() <= 1024
                    && connections.iter().all(|(id, shown)| {
                        !id.is_empty()
                            && id.len() <= 1024
                            && !id.chars().any(char::is_control)
                            && shown.is_boolean()
                    })
            }),
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
    crate::shortcuts::validate_application_shortcut(shortcut).is_ok()
}

pub(crate) fn validate_shortcuts(values: &Map<String, Value>, global: &str) -> Result<(), String> {
    let shortcuts = values
        .get("keyboardShortcuts")
        .ok_or("missing keyboard shortcuts")?;
    crate::shortcuts::validate_in_app_shortcut_conflicts(global, shortcuts)?;
    let mut assigned = std::collections::HashSet::new();
    for value in shortcuts
        .as_object()
        .ok_or("invalid keyboard shortcuts")?
        .values()
    {
        let value = value.as_str().ok_or("invalid keyboard shortcut")?;
        if !value.is_empty()
            && !assigned.insert(crate::shortcuts::validate_application_shortcut(value)?)
        {
            return Err("conflicting keyboard shortcuts".to_owned());
        }
    }
    Ok(())
}

pub(crate) fn load(paths: &HostPaths) -> Result<PreferencesSnapshot, String> {
    storage::get_preferences(&storage::open(paths)?)
}

pub(crate) fn save(
    paths: &HostPaths,
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
    let snapshot = storage::patch_preferences(&mut storage::open(paths)?, patch, migrate)?;
    events.send(RuntimeEventEnvelope::global(
        RuntimeEvent::PreferencesChanged {
            settings: snapshot.clone(),
        },
    ));
    Ok(snapshot)
}

pub fn preferences_get(runtime: &Runtime) -> Result<PreferencesSnapshot, String> {
    load(&runtime.paths)
}

pub fn preferences_patch(
    runtime: &Runtime,
    patch: Map<String, Value>,
    initial: Option<bool>,
) -> Result<PreferencesSnapshot, String> {
    save(
        &runtime.paths,
        &runtime.events,
        patch,
        initial.unwrap_or(false),
    )
}

#[cfg(test)]
mod runtime_tests {
    use super::*;
    use crate::{
        appearance, cache_keep_alive, host_events::RecordingEvents, host_paths::HostPaths,
        next_prompt, prompt_enhancement,
    };
    use std::sync::Arc;

    #[tokio::test]
    async fn runtime_settings_functions_persist_and_validate_without_a_shell() {
        let root =
            std::env::temp_dir().join(format!("pilo-runtime-settings-{}", std::process::id()));
        let host = Arc::new(RecordingEvents::default());
        let runtime = Runtime::new(HostPaths::new(root.clone(), root.join("resources")).unwrap());
        runtime.events.subscribe("test", 1, host.clone());
        let initial = preferences_get(&runtime).unwrap();
        assert_eq!(initial.values["pageFontFamily"], "system-sans");
        assert_eq!(initial.values["readingFontFamily"], "system-sans");
        assert_eq!(initial.values["codeFontFamily"], "system-mono");
        assert_eq!(initial.values["terminalFontFamily"], "system-mono");
        let fonts = preferences_patch(
            &runtime,
            json!({
                "pageFontFamily": "inter", "readingFontFamily": "Inter",
                "codeFontFamily": "JetBrains Mono", "terminalFontFamily": "jetbrains-mono"
            })
            .as_object()
            .unwrap()
            .clone(),
            None,
        )
        .unwrap();
        assert_eq!(fonts.values["pageFontFamily"], "system-sans");
        assert_eq!(fonts.values["readingFontFamily"], "Inter");
        assert_eq!(fonts.values["codeFontFamily"], "JetBrains Mono");
        assert_eq!(fonts.values["terminalFontFamily"], "system-mono");
        assert_eq!(preferences_get(&runtime).unwrap(), fonts);
        let settings = preferences_patch(
            &runtime,
            json!({"desktopNotifications": false})
                .as_object()
                .unwrap()
                .clone(),
            None,
        )
        .unwrap();
        assert!(settings.revision > initial.revision);
        assert_eq!(
            preferences_get(&runtime).unwrap().values["desktopNotifications"],
            false
        );
        assert!(
            preferences_patch(
                &runtime,
                json!({"unknown": true}).as_object().unwrap().clone(),
                None
            )
            .is_err()
        );
        storage::ensure_local_connection(&storage::open(&runtime.paths).unwrap()).unwrap();
        assert!(
            cache_keep_alive::cache_keep_alive_settings_list(&runtime, "local".into())
                .unwrap()
                .is_empty()
        );
        assert!(
            !next_prompt::next_prompt_settings_set(&runtime, "local".into(), false, None)
                .unwrap()
                .enabled
        );
        assert_eq!(
            next_prompt::next_prompt_settings_get(&runtime, "local".into())
                .unwrap()
                .model,
            None
        );
        assert!(
            !prompt_enhancement::prompt_enhancement_settings_set(
                &runtime,
                "local".into(),
                false,
                None
            )
            .unwrap()
            .enabled
        );
        assert_eq!(
            prompt_enhancement::prompt_enhancement_settings_get(&runtime, "local".into())
                .unwrap()
                .model,
            None
        );
        let before = appearance::theme_settings_get(&runtime, None)
            .await
            .unwrap();
        let update = serde_json::from_value(json!({"theme":"dark"})).unwrap();
        let theme = appearance::theme_settings_set(&runtime, update)
            .await
            .unwrap();
        assert!(theme.revision > before.revision);
        assert_eq!(
            serde_json::to_value(
                appearance::theme_settings_get(&runtime, None)
                    .await
                    .unwrap()
            )
            .unwrap()["theme"],
            "dark"
        );
        assert!(!host.events.lock().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
