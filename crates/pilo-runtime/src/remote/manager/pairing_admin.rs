use super::access_settings::load_access_config;
use super::{RemoteHostState, RemoteServerManager, access};
use crate::{Runtime, storage};
use pilo_domain::RemoteScopes;

impl RemoteServerManager {
    pub(crate) async fn regenerate_pairing(
        &self,
        runtime: &Runtime,
        scopes: RemoteScopes,
    ) -> Result<RemoteHostState, String> {
        let paths = runtime.paths.clone();
        let inner = self.inner.lock().await;
        let running = inner
            .running
            .as_ref()
            .ok_or("Remote WebUI is not running")?;
        let pairing = running.pairing.clone();
        let lan_base_url = running.lan_base_url.clone();
        tokio::task::spawn_blocking(move || {
            let db = storage::open_with_paths(&paths)?;
            let config = load_access_config(&db, lan_base_url.as_deref())?;
            pairing.regenerate(&paths, access::pairing_addresses(&config), scopes)
        })
        .await
        .map_err(|_| "Remote WebUI pairing task failed".to_owned())??;
        drop(inner);
        self.snapshot(runtime).await
    }
}
