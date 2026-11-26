//! The app's Rust code: what the TSX imports from `app/native`. The
//! TypeScript declarations are generated from these types into
//! `.nsh/types/app/native.d.ts`.

use nsh_core::prelude::*;

mod dock;
mod editor_links;
mod notifications;
mod pilo;
#[cfg(debug_assertions)]
mod test_fixtures;
mod updater;

#[native_module("app/native")]
fn native(registry: &mut Registry) {
    // nsh's generated macOS runners register native modules before starting the app.
    if let Some(status) = pilo_runtime::handle_ssh_askpass() {
        std::process::exit(status);
    }
    registry.module::<AppInfo>();
    registry.module::<dock::DesktopDock>();
    registry.module::<editor_links::DesktopEditorLinks>();
    registry.module::<notifications::DesktopNotifications>();
    registry.module::<updater::DesktopUpdates>();
    registry.class::<pilo::Pilo>();
    #[cfg(debug_assertions)]
    test_fixtures::register(registry);
}

/// Desktop shell metadata.
#[module]
struct AppInfo;

#[module]
impl AppInfo {
    /// The native crate's version.
    pub fn version() -> String {
        env!("CARGO_PKG_VERSION").to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::AppInfo;

    #[test]
    fn version_matches_crate_metadata() {
        assert_eq!(AppInfo::version(), env!("CARGO_PKG_VERSION"));
        assert!(!AppInfo::version().is_empty());
    }
}
