use pilo_domain::{RemoteAccessAddress, RemoteAccessConfig, RemoteScopes};

use super::RemoteHostState;
use crate::Runtime;

pub async fn remote_host_state(runtime: &Runtime) -> Result<RemoteHostState, String> {
    runtime.remote.snapshot(runtime).await
}

pub async fn remote_lan_addresses(_runtime: &Runtime) -> Result<Vec<String>, String> {
    super::list_lan_ips().await
}

pub async fn remote_set_enabled(
    runtime: &Runtime,
    enabled: bool,
) -> Result<RemoteHostState, String> {
    runtime.remote.set_enabled(runtime, enabled).await
}

pub async fn remote_set_port(runtime: &Runtime, port: u16) -> Result<RemoteHostState, String> {
    runtime.remote.set_port(runtime, port).await
}

pub async fn remote_set_addresses(
    runtime: &Runtime,
    addresses: Vec<RemoteAccessAddress>,
    entry_address_id: String,
) -> Result<RemoteHostState, String> {
    runtime
        .remote
        .set_addresses(
            runtime,
            RemoteAccessConfig {
                addresses,
                entry_address_id,
            },
        )
        .await
}

pub async fn remote_pairing_regenerate(
    runtime: &Runtime,
    scopes: RemoteScopes,
) -> Result<RemoteHostState, String> {
    runtime.remote.regenerate_pairing(runtime, scopes).await
}

pub async fn remote_device_revoke(
    runtime: &Runtime,
    device_id: String,
) -> Result<RemoteHostState, String> {
    runtime.remote.revoke_device(runtime, &device_id).await
}

pub async fn remote_device_rename(
    runtime: &Runtime,
    device_id: String,
    name: String,
) -> Result<RemoteHostState, String> {
    runtime
        .remote
        .rename_device(runtime, &device_id, &name)
        .await
}

pub async fn remote_device_set_scopes(
    runtime: &Runtime,
    device_id: String,
    scopes: RemoteScopes,
) -> Result<RemoteHostState, String> {
    runtime
        .remote
        .set_device_scopes(runtime, &device_id, scopes)
        .await
}

pub async fn remote_devices_revoke_all(runtime: &Runtime) -> Result<RemoteHostState, String> {
    runtime.remote.revoke_all_devices(runtime).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn remote_functions_share_host_config_and_preserve_validation_errors() {
        let root = std::env::temp_dir().join(format!("pilo-runtime-remote-{}", std::process::id()));
        let runtime = Runtime::new(
            crate::host_paths::HostPaths::new(root.clone(), root.join("resources")).unwrap(),
        );
        let initial = remote_host_state(&runtime).await.unwrap();
        assert!(!initial.running);
        assert!(initial.devices.is_empty());
        assert!(
            remote_device_revoke(&runtime, "missing".into())
                .await
                .is_err()
        );
        assert!(
            remote_device_rename(&runtime, "missing".into(), "name".into())
                .await
                .is_err()
        );
        assert!(
            remote_pairing_regenerate(&runtime, RemoteScopes::Chat)
                .await
                .is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
