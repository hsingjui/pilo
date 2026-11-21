#![recursion_limit = "256"]

pub mod domain;
pub mod runtime;

pub use runtime::server_deploy::initialize_local_server_binary;

pub fn handle_ssh_askpass() -> bool {
    runtime::print_askpass_password_from_environment()
}
