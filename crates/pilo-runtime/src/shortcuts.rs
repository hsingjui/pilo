use std::fmt;

const SHIFT: u8 = 1;
const CONTROL: u8 = 1 << 1;
const ALT: u8 = 1 << 2;
const SUPER: u8 = 1 << 3;
const COMMAND_OR_CONTROL: u8 = if cfg!(target_os = "macos") {
    SUPER
} else {
    CONTROL
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Shortcut {
    modifiers: u8,
    key: &'static str,
}

impl fmt::Display for Shortcut {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (flag, name) in [
            (SHIFT, "shift"),
            (CONTROL, "control"),
            (ALT, "alt"),
            (SUPER, "super"),
        ] {
            if self.modifiers & flag != 0 {
                write!(f, "{name}+")?;
            }
        }
        f.write_str(self.key)
    }
}

pub(crate) fn parse(value: &str) -> Result<Shortcut, String> {
    if value.len() > 100 {
        return Err("invalid global shortcut".into());
    }
    let shortcut =
        parse_tokens(value).ok_or_else(|| format!("invalid global shortcut: {value}"))?;
    if shortcut.modifiers & (CONTROL | SUPER | ALT) == 0 && !is_function_key(shortcut.key) {
        return Err("global shortcut requires Ctrl, Command, Alt or a function key".into());
    }
    Ok(shortcut)
}

fn parse_tokens(value: &str) -> Option<Shortcut> {
    let tokens = value.split('+').collect::<Vec<_>>();
    if let [key] = tokens.as_slice() {
        return Some(Shortcut {
            modifiers: 0,
            key: parse_key(key)?,
        });
    }
    let (key, modifiers) = tokens.split_last()?;
    let modifiers = modifiers.iter().try_fold(0, |modifiers, token| {
        Some(modifiers | parse_modifier(token.trim())?)
    })?;
    let key = key.trim();
    (!key.is_empty()).then_some(())?;
    Some(Shortcut {
        modifiers,
        key: parse_key(key)?,
    })
}

fn parse_modifier(token: &str) -> Option<u8> {
    Some(match token.to_ascii_uppercase().as_str() {
        "SHIFT" => SHIFT,
        "CONTROL" | "CTRL" => CONTROL,
        "OPTION" | "ALT" => ALT,
        "COMMAND" | "CMD" | "SUPER" | "META" => SUPER,
        "MOD" | "COMMANDORCONTROL" | "COMMANDORCTRL" | "CMDORCTRL" | "CMDORCONTROL" => {
            COMMAND_OR_CONTROL
        }
        _ => return None,
    })
}

/// Key names accepted by the previous `global-hotkey` parser: the canonical
/// `KeyboardEvent.code` name followed by its aliases, matched case-insensitively.
const KEYS: &[(&str, &[&str])] = &[
    ("KeyA", &["A"]),
    ("KeyB", &["B"]),
    ("KeyC", &["C"]),
    ("KeyD", &["D"]),
    ("KeyE", &["E"]),
    ("KeyF", &["F"]),
    ("KeyG", &["G"]),
    ("KeyH", &["H"]),
    ("KeyI", &["I"]),
    ("KeyJ", &["J"]),
    ("KeyK", &["K"]),
    ("KeyL", &["L"]),
    ("KeyM", &["M"]),
    ("KeyN", &["N"]),
    ("KeyO", &["O"]),
    ("KeyP", &["P"]),
    ("KeyQ", &["Q"]),
    ("KeyR", &["R"]),
    ("KeyS", &["S"]),
    ("KeyT", &["T"]),
    ("KeyU", &["U"]),
    ("KeyV", &["V"]),
    ("KeyW", &["W"]),
    ("KeyX", &["X"]),
    ("KeyY", &["Y"]),
    ("KeyZ", &["Z"]),
    ("Digit0", &["0"]),
    ("Digit1", &["1"]),
    ("Digit2", &["2"]),
    ("Digit3", &["3"]),
    ("Digit4", &["4"]),
    ("Digit5", &["5"]),
    ("Digit6", &["6"]),
    ("Digit7", &["7"]),
    ("Digit8", &["8"]),
    ("Digit9", &["9"]),
    ("Numpad0", &["NUM0"]),
    ("Numpad1", &["NUM1"]),
    ("Numpad2", &["NUM2"]),
    ("Numpad3", &["NUM3"]),
    ("Numpad4", &["NUM4"]),
    ("Numpad5", &["NUM5"]),
    ("Numpad6", &["NUM6"]),
    ("Numpad7", &["NUM7"]),
    ("Numpad8", &["NUM8"]),
    ("Numpad9", &["NUM9"]),
    ("F1", &[]),
    ("F2", &[]),
    ("F3", &[]),
    ("F4", &[]),
    ("F5", &[]),
    ("F6", &[]),
    ("F7", &[]),
    ("F8", &[]),
    ("F9", &[]),
    ("F10", &[]),
    ("F11", &[]),
    ("F12", &[]),
    ("F13", &[]),
    ("F14", &[]),
    ("F15", &[]),
    ("F16", &[]),
    ("F17", &[]),
    ("F18", &[]),
    ("F19", &[]),
    ("F20", &[]),
    ("F21", &[]),
    ("F22", &[]),
    ("F23", &[]),
    ("F24", &[]),
    ("Backquote", &["`"]),
    ("Backslash", &["\\"]),
    ("BracketLeft", &["["]),
    ("BracketRight", &["]"]),
    ("Pause", &["PAUSEBREAK"]),
    ("Comma", &[","]),
    ("Equal", &["="]),
    ("Minus", &["-"]),
    ("Period", &["."]),
    ("Quote", &["'"]),
    ("Semicolon", &[";"]),
    ("Slash", &["/"]),
    ("Backspace", &[]),
    ("CapsLock", &[]),
    ("Enter", &[]),
    ("Space", &[]),
    ("Tab", &[]),
    ("Delete", &[]),
    ("End", &[]),
    ("Home", &[]),
    ("Insert", &[]),
    ("PageDown", &[]),
    ("PageUp", &[]),
    ("PrintScreen", &[]),
    ("ScrollLock", &[]),
    ("ArrowDown", &["DOWN"]),
    ("ArrowLeft", &["LEFT"]),
    ("ArrowRight", &["RIGHT"]),
    ("ArrowUp", &["UP"]),
    ("NumLock", &[]),
    ("NumpadAdd", &["NUMADD", "NUMPADPLUS", "NUMPLUS"]),
    ("NumpadDecimal", &["NUMDECIMAL"]),
    ("NumpadDivide", &["NUMDIVIDE"]),
    ("NumpadEnter", &["NUMENTER"]),
    ("NumpadEqual", &["NUMEQUAL"]),
    ("NumpadMultiply", &["NUMMULTIPLY"]),
    ("NumpadSubtract", &["NUMSUBTRACT"]),
    ("Escape", &["ESC"]),
    ("AudioVolumeDown", &["VOLUMEDOWN"]),
    ("AudioVolumeUp", &["VOLUMEUP"]),
    ("AudioVolumeMute", &["VOLUMEMUTE"]),
    ("MediaPlay", &[]),
    ("MediaPause", &[]),
    ("MediaPlayPause", &[]),
    ("MediaStop", &[]),
    ("MediaTrackNext", &[]),
    ("MediaTrackPrevious", &["MEDIATRACKPREV"]),
];

fn is_function_key(key: &str) -> bool {
    matches!(
        key,
        "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8" | "F9" | "F10" | "F11" | "F12"
    )
}

fn parse_key(key: &str) -> Option<&'static str> {
    KEYS.iter()
        .find(|(name, aliases)| {
            name.eq_ignore_ascii_case(key)
                || aliases.iter().any(|alias| alias.eq_ignore_ascii_case(key))
        })
        .map(|(name, _)| *name)
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
    Ok(format!("{}:{}", shortcut.modifiers, key.to_lowercase()))
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

    #[test]
    fn parses_global_shortcuts_like_the_native_hotkey_parser() {
        assert_eq!(
            parse("Ctrl+Shift+k").unwrap().to_string(),
            "shift+control+KeyK"
        );
        assert_eq!(parse("alt+ArrowUp").unwrap().to_string(), "alt+ArrowUp");
        assert_eq!(parse("meta+/").unwrap().to_string(), "super+Slash");
        assert_eq!(parse("F5").unwrap().to_string(), "F5");
        assert_eq!(parse("shift+f12").unwrap().to_string(), "shift+F12");
        assert_eq!(parse("mod+k"), parse("CommandOrControl+K"));
        assert!(parse("k").is_err());
        assert!(parse("shift+k").is_err());
        assert!(parse("F13").is_err());
        assert!(parse("ctrl+k+j").is_err());
        assert!(parse("ctrl++k").is_err());
        assert!(parse(&format!("ctrl+{}", "k".repeat(100))).is_err());
    }

    #[test]
    fn canonicalizes_application_shortcuts() {
        assert_eq!(
            validate_application_shortcut("ctrl+/"),
            validate_application_shortcut("control+Slash")
        );
        assert_eq!(validate_application_shortcut("ctrl+?").unwrap(), "2:?");
        assert_eq!(
            validate_application_shortcut("ctrl+shift+?").unwrap(),
            validate_application_shortcut("shift+ctrl+?").unwrap()
        );
        assert!(validate_application_shortcut("ctrl+ab").is_err());
        assert!(validate_application_shortcut("shift+?").is_err());
    }
}
