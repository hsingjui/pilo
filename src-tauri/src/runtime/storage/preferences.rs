use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Map, Value};

use crate::runtime::preferences::{PreferencesSnapshot, defaults};

fn stored(db: &Connection) -> Result<(u64, Map<String, Value>, bool), String> {
    let row: Option<(u64, String, bool)> = db
        .query_row(
            "SELECT revision, values_json, migrated FROM preferences WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    match row {
        Some((revision, json, migrated)) => Ok((
            revision,
            serde_json::from_str(&json).map_err(|error| error.to_string())?,
            migrated,
        )),
        None => Ok((0, Map::new(), false)),
    }
}

fn complete(stored: &Map<String, Value>) -> Map<String, Value> {
    let mut values = defaults();
    let mut shortcuts = values["keyboardShortcuts"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    if let Some(stored) = stored.get("keyboardShortcuts").and_then(Value::as_object) {
        shortcuts.extend(stored.clone());
    }
    values.extend(stored.clone());
    values.insert("keyboardShortcuts".to_owned(), Value::Object(shortcuts));
    values
}

pub(crate) fn get_preferences(db: &Connection) -> Result<PreferencesSnapshot, String> {
    let (revision, stored, _) = stored(db)?;
    Ok(PreferencesSnapshot {
        revision,
        values: complete(&stored),
    })
}

pub(crate) fn patch_preferences(
    db: &mut Connection,
    patch: Map<String, Value>,
    migrate: bool,
) -> Result<PreferencesSnapshot, String> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let (revision, mut values, migrated) = stored(&tx)?;
    if migrate && migrated {
        return get_preferences(&tx);
    }
    let shortcuts_changed = patch.contains_key("keyboardShortcuts");
    let global = super::get_show_shortcut(&tx)?;
    for (key, value) in patch {
        if key == "keyboardShortcuts" {
            // Persist only initialized bindings; a CLI-first patch must not erase
            // unrelated legacy bindings during the desktop's one-time migration.
            let mut shortcuts = values
                .get(&key)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let mut reserved = std::collections::HashSet::new();
            if migrate {
                reserved.insert(crate::desktop_shortcut::validate_application_shortcut(
                    &global,
                )?);
                for value in shortcuts
                    .values()
                    .filter_map(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    reserved.insert(crate::desktop_shortcut::validate_application_shortcut(
                        value,
                    )?);
                }
            }
            if let Some(patch) = value.as_object() {
                for (command, binding) in patch {
                    if migrate && shortcuts.contains_key(command) {
                        continue;
                    }
                    let mut binding = binding.clone();
                    if migrate
                        && let Some(value) = binding.as_str().filter(|value| !value.is_empty())
                        && !reserved.insert(crate::desktop_shortcut::validate_application_shortcut(
                            value,
                        )?)
                    {
                        // A Host-initialized shortcut wins over an old browser cache.
                        binding = Value::String(String::new());
                    }
                    shortcuts.insert(command.clone(), binding);
                }
            }
            values.insert(key, Value::Object(shortcuts));
        } else if !migrate || !values.contains_key(&key) {
            values.insert(key, value);
        }
    }
    let complete = complete(&values);
    if shortcuts_changed {
        crate::runtime::preferences::validate_shortcuts(&complete, &global)?;
    }
    let json = serde_json::to_string(&values).map_err(|error| error.to_string())?;
    let revision = revision
        .checked_add(1)
        .ok_or("preference revision exhausted")?;
    tx.execute("INSERT INTO preferences(id, revision, values_json, migrated) VALUES(1, ?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, values_json=excluded.values_json, migrated=excluded.migrated", params![revision, json, migrated || migrate]).map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(PreferencesSnapshot {
        revision,
        values: complete,
    })
}
