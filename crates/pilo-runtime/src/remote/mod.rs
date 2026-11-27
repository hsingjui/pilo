mod access;
mod api;
mod auth;
mod lan;
mod manager;
mod operations;
pub use operations::*;
mod pairing;

pub(crate) use lan::list_lan_ips;
pub use manager::RemoteHostState;
pub(crate) use manager::RemoteServerManager;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Principal {
    Device {
        id: String,
        scopes: pilo_domain::RemoteScopes,
    },
}
