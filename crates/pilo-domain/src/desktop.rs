use serde::{Deserialize, Serialize};

pub const DEFAULT_SHOW_SHORTCUT: &str = "mod+alt+p";

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AutostartMode {
    #[default]
    Disabled,
    Window,
    Tray,
}

impl AutostartMode {
    pub fn starts_hidden(self, from_autostart: bool, tray_available: bool) -> bool {
        from_autostart && tray_available && self == Self::Tray
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_autostart_with_a_working_tray_can_start_hidden() {
        for mode in [
            AutostartMode::Disabled,
            AutostartMode::Window,
            AutostartMode::Tray,
        ] {
            for autostart in [false, true] {
                for tray in [false, true] {
                    assert_eq!(
                        mode.starts_hidden(autostart, tray),
                        mode == AutostartMode::Tray && autostart && tray
                    );
                }
            }
        }
    }
}
