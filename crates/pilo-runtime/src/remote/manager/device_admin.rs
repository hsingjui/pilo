use super::{RemoteHostState, RemoteServerManager, next_auth_generation};
use crate::{Runtime, storage};
use pilo_domain::RemoteScopes;

impl RemoteServerManager {
    pub(crate) async fn revoke_device(
        &self,
        runtime: &Runtime,
        device_id: &str,
    ) -> Result<RemoteHostState, String> {
        let paths = runtime.paths.clone();
        let db = storage::open_with_paths(&paths)?;
        if !storage::revoke_remote_device(&db, device_id, storage::now_ms())? {
            return Err(format!(
                "Remote device '{device_id}' was not found or already revoked"
            ));
        }
        if let Some(running) = self.inner.lock().await.running.as_ref() {
            running.auth_generation.send_replace(next_auth_generation());
        }
        runtime.terminals.close_by_device(device_id).await;
        self.snapshot(runtime).await
    }

    pub(crate) async fn rename_device(
        &self,
        runtime: &Runtime,
        device_id: &str,
        name: &str,
    ) -> Result<RemoteHostState, String> {
        let paths = runtime.paths.clone();
        let db = storage::open_with_paths(&paths)?;
        let name = super::super::auth::normalize_device_name(Some(name));
        if !storage::rename_remote_device(&db, device_id, &name)? {
            return Err(format!(
                "Remote device '{device_id}' was not found or already revoked"
            ));
        }
        self.snapshot(runtime).await
    }

    pub(crate) async fn set_device_scopes(
        &self,
        runtime: &Runtime,
        device_id: &str,
        scopes: RemoteScopes,
    ) -> Result<RemoteHostState, String> {
        let inner = self.inner.lock().await;
        let db = storage::open_with_paths(&runtime.paths)?;
        if !storage::set_remote_device_scopes(&db, device_id, scopes)? {
            return Err(format!(
                "Remote device '{device_id}' was not found or already revoked"
            ));
        }
        if let Some(running) = inner.running.as_ref() {
            running.auth_generation.send_replace(next_auth_generation());
        }
        drop(inner);
        if scopes != RemoteScopes::ChatWorkspace {
            runtime.terminals.close_by_device(device_id).await;
        }
        self.snapshot(runtime).await
    }

    pub(crate) async fn revoke_all_devices(
        &self,
        runtime: &Runtime,
    ) -> Result<RemoteHostState, String> {
        let _lifecycle = self.lifecycle.lock().await;
        let inner = self.inner.lock().await;
        let pairing = inner
            .running
            .as_ref()
            .map(|running| running.pairing.clone());
        let paths = runtime.paths.clone();
        tokio::task::spawn_blocking(move || {
            if let Some(pairing) = pairing {
                pairing.invalidate();
            }
            let mut db = storage::open_with_paths(&paths)?;
            let transaction = db.transaction().map_err(|error| error.to_string())?;
            storage::clear_remote_pairing(&transaction)?;
            storage::revoke_all_remote_devices(&transaction, storage::now_ms())?;
            transaction.commit().map_err(|error| error.to_string())
        })
        .await
        .map_err(|_| "Remote WebUI revoke task failed".to_owned())??;
        if let Some(running) = inner.running.as_ref() {
            running.auth_generation.send_replace(next_auth_generation());
        }
        drop(inner);
        runtime.terminals.close_all_remote().await;
        self.snapshot(runtime).await
    }
}
