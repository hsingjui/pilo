use tauri::AppHandle;

use crate::domain::{RemoteAccessAddress, RemoteAccessConfig};

use super::RemoteHostState;
use crate::runtime::Runtime;

pub async fn remote_host_state(runtime: &Runtime) -> Result<RemoteHostState, String> {
    runtime.remote.snapshot(runtime).await
}

pub async fn remote_lan_addresses(_runtime: &Runtime) -> Result<Vec<String>, String> {
    super::list_lan_ips().await
}

pub async fn remote_set_enabled(
    runtime: &Runtime,
    app: AppHandle,
    enabled: bool,
) -> Result<RemoteHostState, String> {
    runtime.remote.set_enabled(runtime, app, enabled).await
}

pub async fn remote_set_port(
    runtime: &Runtime,
    app: AppHandle,
    port: u16,
) -> Result<RemoteHostState, String> {
    runtime.remote.set_port(runtime, app, port).await
}

pub async fn remote_set_public_base_url(
    runtime: &Runtime,
    public_base_url: String,
) -> Result<RemoteHostState, String> {
    runtime
        .remote
        .set_public_base_url(runtime, &public_base_url)
        .await
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

pub async fn remote_pairing_regenerate(runtime: &Runtime) -> Result<RemoteHostState, String> {
    runtime.remote.regenerate_pairing(runtime).await
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn remote_functions_share_host_config_and_preserve_validation_errors() {
        let root = std::env::temp_dir().join(format!("pilo-runtime-remote-{}", std::process::id()));
        let runtime = Runtime::new(
            crate::runtime::host_paths::HostPaths::new(root.clone(), root.join("resources"))
                .unwrap(),
            std::sync::Arc::new(crate::runtime::host_events::RecordingEvents::default()),
        );
        let initial = remote_host_state(&runtime).await.unwrap();
        assert!(!initial.running);
        assert!(initial.devices.is_empty());
        let state = remote_set_public_base_url(&runtime, "https://example.com/".into())
            .await
            .unwrap();
        assert_eq!(state.public_base_url, "https://example.com");
        assert!(
            remote_set_public_base_url(&runtime, "invalid".into())
                .await
                .is_err()
        );
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
        assert!(remote_pairing_regenerate(&runtime).await.is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
