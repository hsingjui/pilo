//! The app's Rust code: what the TSX imports from `app/native`. The
//! TypeScript declarations are generated from these types into
//! `.nsh/types/app/native.d.ts`.

use nsh_core::prelude::*;

#[native_module("app/native")]
fn native(registry: &mut Registry) {
    registry.module::<AppInfo>();
    #[cfg(debug_assertions)]
    registry.module::<ImageFixture>();
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

#[cfg(debug_assertions)]
#[module]
/// Native image sources for the desktop transport tests.
struct ImageFixture;

#[cfg(debug_assertions)]
#[module]
impl ImageFixture {
    /// The fixture PNG as native bytes.
    pub fn bytes() -> Vec<u8> {
        include_bytes!("../../../src-tauri/icons/32x32.png").to_vec()
    }

    /// The fixture PNG as an absolute local path.
    pub fn path() -> String {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src-tauri/icons/32x32.png")
            .to_string_lossy()
            .into_owned()
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
