use pilo_protocol::ControlCommand;
use serde_json::{Value, json};

use super::{changed, decode, encode, required};
use crate::domain::ThemeSettingsUpdate;
use crate::runtime::{Runtime, preferences, project, storage};

pub(super) async fn settings(runtime: &Runtime, command: ControlCommand) -> Result<Value, String> {
    let key = required(command.key.as_deref(), "setting key")?;
    let get = command.method == "settings.get";
    let reset = command.method == "settings.reset";
    if reset && key != "connection.cacheKeepAlive" && !command.value.is_null() {
        return Err("this setting reset does not accept a JSON value".to_owned());
    }
    let events = &runtime.events;
    if let Some(name) = key.strip_prefix("preferences.") {
        let default = preferences::defaults()
            .get(name)
            .cloned()
            .ok_or("unknown preference")?;
        if get {
            let snapshot = preferences::load(&runtime.paths)?;
            return Ok(
                json!({ "key": key, "value": snapshot.values.get(name), "revision": snapshot.revision }),
            );
        }
        let mut patch = serde_json::Map::new();
        patch.insert(name.to_owned(), if reset { default } else { command.value });
        let snapshot = preferences::save(&runtime.paths, events, patch, false)?;
        return Ok(
            json!({ "key": key, "value": snapshot.values.get(name), "revision": snapshot.revision, "effect": if name == "desktopNotifications" { "saved; delivery still requires OS/browser notification permission" } else { "saved" } }),
        );
    }
    if let Some(name) = key.strip_prefix("theme.") {
        if !matches!(
            name,
            "theme"
                | "themeFamily"
                | "themeCustomCss"
                | "themeCustomName"
                | "savedCustomThemes"
                | "saveCustomTheme"
                | "deleteCustomTheme"
        ) {
            return Err("unknown theme setting".to_owned());
        }
        if name == "savedCustomThemes" && !get {
            return Err(
                "saved themes are managed through saveCustomTheme/deleteCustomTheme".to_owned(),
            );
        }
        let defaults = encode(crate::domain::ThemeSettings::default())?;
        if get {
            let settings =
                crate::runtime::appearance::load(runtime.paths.clone(), events.clone(), None)
                    .await?;
            let settings = encode(settings)?;
            return settings
                .get(name)
                .cloned()
                .ok_or_else(|| "theme mutation key is write-only".to_owned());
        }
        let value = if reset {
            defaults
                .get(name)
                .cloned()
                .ok_or("theme action cannot be reset; use deleteCustomTheme to remove an item")?
        } else {
            command.value
        };
        if value.is_null() {
            return Err("theme settings require a non-null value".to_owned());
        }
        let mut update = serde_json::Map::new();
        update.insert(name.to_owned(), value);
        let update: ThemeSettingsUpdate = decode(Value::Object(update))?;
        return encode(
            crate::runtime::appearance::save(runtime.paths.clone(), events.clone(), update).await?,
        );
    }
    let value = command.value;
    let result = match key.as_str() {
        "desktop.autostart" | "desktop.exitOnClose" | "desktop.showShortcut" => {
            let value = if get {
                None
            } else {
                Some(if reset {
                    match key.as_str() {
                        "desktop.autostart" => json!("disabled"),
                        "desktop.exitOnClose" => json!(false),
                        _ => json!(crate::domain::DEFAULT_SHOW_SHORTCUT),
                    }
                } else {
                    value
                })
            };
            runtime.shell()?.desktop_setting(key.clone(), value).await
        }
        "project.models" => {
            let id = required(command.project_id.as_deref(), "--project")?;
            if get {
                encode(project::load_model_scope(runtime, &id)?)
            } else {
                encode(project::save_model_scope(
                    runtime,
                    events,
                    &id,
                    decode(if reset { Value::Null } else { value })?,
                )?)
            }
        }
        "connection.namingModel"
        | "connection.nextPrompt"
        | "connection.promptEnhancement"
        | "connection.cacheKeepAlive" => {
            let id = required(command.connection_id.as_deref(), "--connection")?;
            storage::get_connection(&storage::open(&runtime.paths)?, &id)?
                .ok_or("target connection not found")?;
            match key.as_str() {
                "connection.namingModel" => {
                    if get {
                        encode(crate::runtime::connections::connection_naming_model_get(
                            runtime, id,
                        )?)
                    } else {
                        #[derive(serde::Deserialize)]
                        #[serde(rename_all = "camelCase", deny_unknown_fields)]
                        struct Model {
                            provider: String,
                            model_id: String,
                        }
                        let model: Option<Model> = decode(if reset { Value::Null } else { value })?;
                        let (provider, model_id) = model
                            .map(|model| (Some(model.provider), Some(model.model_id)))
                            .unwrap_or_default();
                        encode(crate::runtime::connections::connection_naming_model_set(
                            runtime, id, provider, model_id,
                        )?)
                    }
                }
                "connection.nextPrompt" => {
                    if get {
                        encode(crate::runtime::next_prompt::next_prompt_settings_get(
                            runtime, id,
                        )?)
                    } else {
                        #[derive(serde::Deserialize)]
                        #[serde(deny_unknown_fields)]
                        struct Settings {
                            enabled: bool,
                            model: Option<crate::domain::NextPromptModel>,
                        }
                        let settings: Settings = decode(if reset {
                            json!({ "enabled": false, "model": null })
                        } else {
                            value
                        })?;
                        encode(crate::runtime::next_prompt::next_prompt_settings_set(
                            runtime,
                            id,
                            settings.enabled,
                            settings.model,
                        )?)
                    }
                }
                "connection.promptEnhancement" => {
                    if get {
                        encode(
                            crate::runtime::prompt_enhancement::prompt_enhancement_settings_get(
                                runtime, id,
                            )?,
                        )
                    } else {
                        #[derive(serde::Deserialize)]
                        #[serde(deny_unknown_fields)]
                        struct Settings {
                            enabled: bool,
                            model: Option<crate::domain::PromptEnhancementModel>,
                        }
                        let settings: Settings = decode(if reset {
                            json!({ "enabled": false, "model": null })
                        } else {
                            value
                        })?;
                        encode(
                            crate::runtime::prompt_enhancement::prompt_enhancement_settings_set(
                                runtime,
                                id,
                                settings.enabled,
                                settings.model,
                            )?,
                        )
                    }
                }
                _ => {
                    if get {
                        encode(
                            crate::runtime::cache_keep_alive::cache_keep_alive_settings_list(
                                runtime, id,
                            )?,
                        )
                    } else {
                        let mut settings = value
                            .as_object()
                            .cloned()
                            .ok_or("cache settings require explicit provider/modelId JSON")?;
                        if reset {
                            settings.extend(json!({ "enabled": false, "cacheTtlSeconds": 300, "idleKeepAliveSeconds": 1800 }).as_object().cloned().unwrap_or_default());
                        }
                        if settings
                            .get("connectionId")
                            .is_some_and(|value| value.as_str() != Some(id.as_str()))
                        {
                            return Err(
                                "cache policy connection differs from --connection".to_owned()
                            );
                        }
                        settings.insert("connectionId".to_owned(), json!(id));
                        settings.entry("updatedAtMs".to_owned()).or_insert(json!(0));
                        encode(
                            crate::runtime::cache_keep_alive::cache_keep_alive_settings_set(
                                runtime,
                                decode(Value::Object(settings))?,
                            )
                            .await?,
                        )
                    }
                }
            }
        }
        "remote.devices" => {
            if !get {
                return Err("remote.devices is read-only".to_owned());
            }
            encode(&runtime.remote.snapshot(runtime).await?.devices)
        }
        "remote.deviceName" | "remote.revokeDevice" => {
            if get || reset {
                return Err("remote device actions require settings set".to_owned());
            }
            let remote = &runtime.remote;
            let state = if key == "remote.revokeDevice" {
                remote
                    .revoke_device(runtime, &decode::<String>(value)?)
                    .await?
            } else {
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Rename {
                    device_id: String,
                    name: String,
                }
                let rename: Rename = decode(value)?;
                remote
                    .rename_device(runtime, &rename.device_id, &rename.name)
                    .await?
            };
            encode(state.devices)
        }
        "remote.enabled" | "remote.port" | "remote.publicBaseUrl" | "remote.addresses" => {
            let remote = &runtime.remote;
            let state = if get {
                remote.snapshot(runtime).await?
            } else {
                match key.as_str() {
                    "remote.enabled" => {
                        remote
                            .set_enabled(runtime, decode(if reset { json!(false) } else { value })?)
                            .await?
                    }
                    "remote.port" => {
                        remote
                            .set_port(
                                runtime,
                                decode(if reset {
                                    json!(crate::domain::random_remote_port())
                                } else {
                                    value
                                })?,
                            )
                            .await?
                    }
                    "remote.publicBaseUrl" => {
                        remote
                            .set_public_base_url(
                                runtime,
                                &decode::<String>(if reset { json!("") } else { value })?,
                            )
                            .await?
                    }
                    _ => {
                        if reset {
                            return Err(
                                "provide the replacement remote address configuration explicitly"
                                    .to_owned(),
                            );
                        }
                        remote.set_addresses(runtime, decode(value)?).await?
                    }
                }
            };
            // Pairing URLs are bearer credentials, not ordinary settings.
            Ok(match key.as_str() {
                "remote.enabled" => {
                    json!({ "enabled": state.enabled, "running": state.running, "lastError": state.last_error })
                }
                "remote.port" => json!(state.port),
                "remote.publicBaseUrl" => json!(state.public_base_url),
                _ => {
                    json!({ "addresses": state.addresses, "entryAddressId": state.entry_address_id })
                }
            })
        }
        _ => Err("unknown setting key; use settings list".to_owned()),
    }?;
    if !get {
        changed(runtime);
    }
    Ok(
        json!({ "key": key, "value": result, "connectionId": command.connection_id, "projectId": command.project_id }),
    )
}
