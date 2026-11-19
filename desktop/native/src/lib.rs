//! The app's Rust code: what the TSX imports from `app/native`. The
//! TypeScript declarations are generated from these types into
//! `.nsh/types/app/native.d.ts`.

mod pilo;

use nsh_core::prelude::*;

/// The crate's set (`nsh.json` `"rust"`).
#[native_module("app/native")]
fn native(registry: &mut Registry) {
    registry.class::<pilo::Pilo>();
}
