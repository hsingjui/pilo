//! The local Host IPC contract: endpoint derivation, length-prefixed JSON frames
//! and the hello handshake. Shared by the desktop Host and the `pilo` CLI.

use std::time::Duration;

pub mod endpoint;
pub mod frame;
mod hello;

pub use endpoint::{Endpoint, UnixEndpoint, validate_app_id};
pub use frame::{FrameError, MAX_FRAME_BYTES, read_frame, write_frame};
pub use hello::{ClientHello, HostHello, Installation, protocol_compatible};

pub const PROTOCOL_VERSION: &str = "2.0";
pub const RELEASE_APP_ID: &str = "app.hsingjui.pilo";
pub const DEV_APP_ID: &str = "app.hsingjui.pilo.dev";
/// Upper bound for the whole hello exchange, on both sides.
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// Default CLI wait for one request; `--timeout` overrides it.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Error codes that only occur on the IPC transport, besides Host API codes.
pub mod error_code {
    pub const INCOMPATIBLE_PROTOCOL: &str = "incompatible_protocol";
    pub const INVALID_FRAME: &str = "invalid_frame";
    pub const UNSUPPORTED_METHOD: &str = "unsupported_method";
}
