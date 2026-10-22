use crate::runtime::preferences;
use serde_json::{Value, json};

pub(super) fn catalog() -> Value {
    let mut entries = preferences::defaults().into_iter().map(|(key, default)| {
        let constraint = match key.as_str() {
            "locale" => json!({ "enum": ["en-US", "zh-CN"] }),
            "sendMessageShortcut" => json!({ "enum": ["enter", "mod-enter"] }),
            "uiFontSize" => json!({ "minimum": 12, "maximum": 18 }),
            "readingFontSize" => json!({ "minimum": 12, "maximum": 32 }),
            "codeFontSize" | "terminalFontSize" => json!({ "minimum": 10, "maximum": 24 }),
            "keyboardShortcuts" => json!({ "description": "partial command-to-shortcut map; empty string unbinds; modifiers mod/ctrl/meta/alt/shift" }),
            _ if default.is_string() => json!({ "maxLength": 512, "minLength": 1 }),
            _ => json!({}),
        };
        json!({ "key": format!("preferences.{key}"), "scope": if key == "showPluginNotifications" { "desktop" } else { "host" }, "type": if default.is_boolean() { "boolean" } else if default.is_number() { "number" } else if default.is_object() { "object" } else { "string" }, "default": default, "constraints": constraint, "secret": false, "reset": true })
    }).collect::<Vec<_>>();
    for (key, scope, schema, default) in [
        (
            "theme.theme",
            "host",
            json!({ "enum": ["system", "light", "dark"] }),
            json!("system"),
        ),
        (
            "theme.themeFamily",
            "host",
            json!({ "enum": ["lody", "claude", "custom"] }),
            json!("lody"),
        ),
        (
            "theme.themeCustomCss",
            "host",
            json!({ "type": "string" }),
            json!(""),
        ),
        (
            "theme.themeCustomName",
            "host",
            json!({ "type": "string" }),
            json!(""),
        ),
        (
            "theme.saveCustomTheme",
            "host",
            json!({ "type": "object", "required": ["name", "css"] }),
            Value::Null,
        ),
        (
            "theme.deleteCustomTheme",
            "host",
            json!({ "type": "string" }),
            Value::Null,
        ),
        (
            "desktop.autostart",
            "desktop",
            json!({ "enum": ["disabled", "window", "tray"] }),
            json!("disabled"),
        ),
        (
            "desktop.exitOnClose",
            "desktop",
            json!({ "type": "boolean" }),
            json!(false),
        ),
        (
            "desktop.showShortcut",
            "desktop",
            json!({ "type": "string", "description": "OS global shortcut; registration must succeed" }),
            json!("mod+alt+p"),
        ),
        (
            "connection.namingModel",
            "connection",
            json!({ "nullable": true, "required": ["provider", "modelId"] }),
            Value::Null,
        ),
        (
            "connection.nextPrompt",
            "connection",
            json!({ "required": ["enabled", "model"], "model": "null | {provider,id}" }),
            json!({ "enabled": false, "model": null }),
        ),
        (
            "connection.promptEnhancement",
            "connection",
            json!({ "required": ["enabled", "model"], "model": "null | {provider,id}" }),
            json!({ "enabled": false, "model": null }),
        ),
        (
            "connection.cacheKeepAlive",
            "connection",
            json!({ "required": ["provider", "modelId", "enabled", "cacheTtlSeconds", "idleKeepAliveSeconds"], "resetRequires": ["provider", "modelId"], "cacheTtlSeconds": [10,86400], "idleKeepAliveSeconds": [60,86400] }),
            json!({ "enabled": false, "cacheTtlSeconds": 300, "idleKeepAliveSeconds": 1800 }),
        ),
        (
            "project.models",
            "project",
            json!({ "oneOf": [{ "type": "null" }, { "type": "array", "items": { "type": "object", "required": ["provider", "modelId"], "properties": { "provider": { "type": "string" }, "modelId": { "type": "string" }, "thinkingLevel": { "enum": [null, "off", "minimal", "low", "medium", "high", "xhigh", "max"] }, "isDefault": { "type": "boolean", "default": false } } } }], "description": "null inherits Pi; at most one model may be marked default" }),
            Value::Null,
        ),
        (
            "remote.enabled",
            "desktop",
            json!({ "type": "boolean" }),
            json!(false),
        ),
        (
            "remote.port",
            "desktop",
            json!({ "type": "integer", "minimum": 1024, "maximum": 65535 }),
            json!("random port in 10000..65535"),
        ),
        (
            "remote.publicBaseUrl",
            "desktop",
            json!({ "type": "string", "description": "validated public URL or empty" }),
            json!(""),
        ),
        (
            "remote.addresses",
            "desktop",
            json!({ "required": ["addresses", "entryAddressId"] }),
            Value::Null,
        ),
    ] {
        entries.push(json!({ "key": key, "scope": scope, "schema": schema, "default": default, "secret": false, "reset": !matches!(key, "theme.saveCustomTheme" | "theme.deleteCustomTheme" | "remote.addresses"), "platform": if key == "desktop.autostart" { "Host OS autostart service" } else { "Host" } }));
    }
    entries.push(json!({ "key": "theme.savedCustomThemes", "scope": "host", "type": "array", "readOnly": true, "secret": false }));
    entries.push(json!({ "key": "remote.deviceName", "scope": "desktop", "schema": { "required": ["deviceId", "name"] }, "secret": false, "reset": false }));
    entries.push(json!({ "key": "remote.revokeDevice", "scope": "desktop", "schema": { "type": "string", "description": "device ID" }, "secret": false, "reset": false }));
    entries.push(json!({ "key": "remote.devices", "scope": "desktop", "type": "array", "readOnly": true, "secret": false }));
    let connection_schema = json!({
        "type": "object", "required": ["connection"], "additionalProperties": false,
        "properties": {
            "password": { "type": ["string", "null"], "writeOnly": true, "description": "SSH only; omitted retains existing credential" },
            "connection": {
                "type": "object", "required": ["id", "name", "kind"],
                "properties": {
                    "id": { "type": "string", "maxLength": 256 }, "name": { "type": "string", "maxLength": 256 },
                    "piExecutable": { "type": ["string", "null"] },
                    "piRuntime": { "enum": ["workspace", "local"], "default": "workspace" },
                    "shownInHome": { "type": "boolean", "default": false },
                    "kind": { "oneOf": [
                        { "type": "object", "required": ["type"], "properties": { "type": { "const": "local" } }, "description": "reserved id local; workspace runtime only" },
                        { "type": "object", "required": ["type", "distro"], "properties": { "type": { "const": "wsl" }, "distro": { "type": "string" } } },
                        { "type": "object", "required": ["type", "target"], "properties": { "type": { "const": "ssh" }, "target": { "oneOf": [
                            { "type": "object", "required": ["type", "host"], "properties": { "type": { "const": "config_host" }, "host": { "type": "string" }, "authMethod": { "enum": ["agent", "key", "password"], "default": "agent" } } },
                            { "type": "object", "required": ["type", "hostname"], "properties": { "type": { "const": "direct" }, "hostname": { "type": "string" }, "port": { "type": ["integer", "null"], "minimum": 1, "maximum": 65535 }, "user": { "type": ["string", "null"] }, "identityFile": { "type": ["string", "null"] }, "proxyJump": { "type": ["string", "null"] }, "authMethod": { "enum": ["agent", "key", "password"], "default": "agent" } } }
                        ] } } }
                    ] }
                }
            }
        }
    });
    json!({ "hostPlatform": std::env::consts::OS, "settings": entries, "connectionsSave": { "stdinOnly": true, "schema": connection_schema, "secret": ["password"], "passwordReadback": false }, "target": "connection/project scoped commands require --connection/--project; paths use the target environment", "limitBytes": pilo_protocol::CONTROL_MAX_BYTES })
}
