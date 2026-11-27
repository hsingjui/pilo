//! The structured values the `Pilo` class takes and returns in TypeScript.

use nsh_core::prelude::*;

/// Desktop-only preferences shared with the previous shell.
#[derive(JsObject)]
pub struct NativeDesktopSettings {
    pub show_shortcut: String,
    pub exit_on_close: bool,
}
