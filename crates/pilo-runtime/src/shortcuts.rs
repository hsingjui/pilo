use global_hotkey::hotkey::{Code, HotKey as Shortcut, Modifiers};

pub(crate) fn parse(value: &str) -> Result<Shortcut, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_application_shortcuts_and_conflicts_without_a_shell() {
        assert!(validate_application_shortcut("mod+k").is_ok());
        assert!(validate_application_shortcut("ctrl+?").is_ok());
        assert!(validate_application_shortcut("").is_err());
        assert!(validate_application_shortcut("mod+").is_err());
        assert!(
            validate_in_app_shortcut_conflicts("mod+k", &serde_json::json!({"open": "mod+k"}))
                .is_err()
        );
        assert!(validate_in_app_shortcut_conflicts("mod+k", &serde_json::json!({})).is_ok());
    }
}
