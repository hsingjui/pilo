use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::{Mutex, Notify, RwLock};

use crate::{domain::Connection, runtime::connection_diagnostics::request_failure_reason};

use super::ServerClient;

fn log_request_setup_failure(
    connection: &Connection,
    method: &str,
    stage: &str,
    started: std::time::Instant,
    error: &str,
) {
    if let Some(reason) = request_failure_reason(method, error) {
        log::warn!(target: "pilo-server", "request setup failed connectionId={:?} method={method:?} stage={stage} elapsedMs={} reason={reason}", connection.id, started.elapsed().as_millis());
    }
}

pub(super) fn retryable_read_method(method: &str) -> bool {
    matches!(
        method,
        "server.ping"
            | "server.status"
            | "environment.inspect"
            | "environment.pi_probe"
            | "fs.read_dir"
            | "fs.read_file"
            | "fs.stat"
            | "fs.search"
            | "session.scan"
            | "session.activity"
            | "session.search"
            | "session.read"
            | "session.discover"
            | "preview.ports"
    )
}

#[derive(Default)]
pub struct ServerManager {
    clients: Mutex<HashMap<String, CachedServerClient>>,
    connection_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    admission: RwLock<()>,
    shutdown: AtomicBool,
    shutdown_notify: Notify,
}

struct CachedServerClient {
    connection: Connection,
    client: Arc<ServerClient>,
}

impl ServerManager {
    const SHUTTING_DOWN: &str = "pilo-server manager is shutting down";

    fn ensure_running(&self) -> Result<(), String> {
        if self.shutdown.load(Ordering::Acquire) {
            Err(Self::SHUTTING_DOWN.to_owned())
        } else {
            Ok(())
        }
    }

    async fn until_shutdown<T>(
        &self,
        operation: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let notified = self.shutdown_notify.notified();
        tokio::pin!(notified);
        // Register before checking the flag so shutdown cannot be missed between
        // the check and the first poll of the operation.
        notified.as_mut().enable();
        self.ensure_running()?;
        tokio::select! {
            biased;
            _ = &mut notified => Err(Self::SHUTTING_DOWN.to_owned()),
            result = operation => result,
        }
    }

    pub async fn client(&self, connection: &Connection) -> Result<Arc<ServerClient>, String> {
        if let Some(client) = self.cached_client(connection).await {
            return Ok(client);
        }

        let _admission_guard = self.admission.read().await;
        self.ensure_running()?;

        let connection_lock = {
            let mut locks = self.connection_locks.lock().await;
            Arc::clone(
                locks
                    .entry(connection.id.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let _connection_guard = self
            .until_shutdown(async { Ok(connection_lock.lock().await) })
            .await?;
        self.ensure_running()?;
        if let Some(client) = self.cached_client(connection).await {
            return Ok(client);
        }

        let client = self
            .until_shutdown(ServerClient::connect(connection))
            .await?;
        self.clients.lock().await.insert(
            connection.id.clone(),
            CachedServerClient {
                connection: connection.clone(),
                client: Arc::clone(&client),
            },
        );
        Ok(client)
    }

    async fn cached_client(&self, connection: &Connection) -> Option<Arc<ServerClient>> {
        let stale = {
            let mut clients = self.clients.lock().await;
            match clients.get(&connection.id) {
                Some(cached)
                    if cached.connection.kind.eq(&connection.kind)
                        && !cached.client.is_closed() =>
                {
                    return Some(Arc::clone(&cached.client));
                }
                Some(_) => clients.remove(&connection.id).map(|cached| cached.client),
                None => None,
            }
        };
        if let Some(client) = stale {
            client.stop().await;
        }
        None
    }

    async fn invalidate_client(&self, connection_id: &str, failed: &Arc<ServerClient>) {
        let removed = {
            let mut clients = self.clients.lock().await;
            match clients.get(connection_id) {
                Some(current) if Arc::ptr_eq(&current.client, failed) => {
                    clients.remove(connection_id).map(|cached| cached.client)
                }
                _ => None,
            }
        };
        if let Some(client) = removed {
            client.stop().await;
        }
    }

    async fn request_raw(
        &self,
        connection: &Connection,
        method: &str,
        params: Value,
        binary: Vec<Vec<u8>>,
    ) -> Result<(Value, Vec<Vec<u8>>), String> {
        let started = std::time::Instant::now();
        let client = self.client(connection).await.inspect_err(|error| {
            log_request_setup_failure(connection, method, "connect", started, error);
        })?;
        let retry_params =
            (retryable_read_method(method) && binary.is_empty()).then(|| params.clone());
        match client.request_with_binary(method, params, binary).await {
            Ok(response) => Ok(response),
            Err(error) if retry_params.is_some() && client.is_closed() => {
                self.invalidate_client(&connection.id, &client).await;
                let retry_client = self.client(connection).await.inspect_err(|error| {
                    log_request_setup_failure(connection, method, "reconnect", started, error);
                })?;
                retry_client
                    .request_with_binary(
                        method,
                        retry_params.expect("retry params are present"),
                        Vec::new(),
                    )
                    .await
                    .map_err(|retry_error| {
                        format!(
                            "{error}; pilo-server reconnect retry for '{method}' failed: {retry_error}"
                        )
                    })
            }
            Err(error) => Err(error),
        }
    }

    pub async fn request(
        &self,
        connection: &Connection,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let (value, binary) = self
            .request_raw(connection, method, params, Vec::new())
            .await?;
        if !binary.is_empty() {
            log::warn!(target: "pilo-server", "response invalid connectionId={:?} method={method:?} reason=unexpected_binary", connection.id);
            return Err(format!(
                "pilo-server method '{method}' returned unexpected binary attachments"
            ));
        }
        Ok(value)
    }

    pub async fn test_connection(&self, connection: &Connection) -> Result<Value, String> {
        let _admission_guard = self.admission.read().await;
        self.ensure_running()?;
        // Connection tests must validate the current configuration and credentials,
        // so do not reuse a pooled client that may have been created before edits.
        let client = self
            .until_shutdown(ServerClient::connect(connection))
            .await?;
        let result = self
            .until_shutdown(client.request("server.ping", Value::Null))
            .await;
        client.stop().await;
        result
    }

    pub async fn request_with_binary(
        &self,
        connection: &Connection,
        method: &str,
        params: Value,
        binary: Vec<Vec<u8>>,
    ) -> Result<(Value, Vec<Vec<u8>>), String> {
        self.request_raw(connection, method, params, binary).await
    }

    pub async fn request_typed<T: DeserializeOwned>(
        &self,
        connection: &Connection,
        method: &str,
        params: Value,
    ) -> Result<T, String> {
        let started = std::time::Instant::now();
        serde_json::from_value(self.request(connection, method, params).await?).map_err(|error| {
            log::warn!(target: "pilo-server", "response invalid connectionId={:?} method={method:?} elapsedMs={} reason=invalid_response", connection.id, started.elapsed().as_millis());
            format!("invalid pilo-server response for {method}: {error}")
        })
    }

    pub(crate) fn begin_shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
        self.shutdown_notify.notify_waiters();
    }

    pub async fn stop_all(&self) {
        self.begin_shutdown();
        let _admission_guard = self.admission.write().await;
        let clients = self
            .clients
            .lock()
            .await
            .drain()
            .map(|(_, cached)| cached.client)
            .collect::<Vec<_>>();
        let mut stops = tokio::task::JoinSet::new();
        for client in clients {
            stops.spawn(async move { client.stop().await });
        }
        while stops.join_next().await.is_some() {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ConnectionKind;
    use std::{future::Future, task::Poll, time::Duration};

    fn connection() -> Connection {
        Connection {
            id: "local".to_owned(),
            name: "Local".to_owned(),
            pi_executable: None,
            pi_runtime: Default::default(),
            kind: ConnectionKind::Local,
            shown_in_home: true,
        }
    }

    #[tokio::test]
    async fn pending_connection_keeps_admission_parallel_and_is_cancelled_on_shutdown() {
        let manager = ServerManager::default();
        let connection = connection();
        let connection_lock = Arc::new(Mutex::new(()));
        let _blocked_connection = connection_lock.lock().await;
        manager
            .connection_locks
            .lock()
            .await
            .insert(connection.id.clone(), Arc::clone(&connection_lock));
        let request = manager.client(&connection);
        tokio::pin!(request);
        std::future::poll_fn(|cx| {
            assert!(request.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;

        // A cold connection must not take exclusive admission from other environments.
        drop(manager.admission.try_read().expect("parallel admission"));
        manager.begin_shutdown();
        let (result, ()) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(request, manager.stop_all())
        })
        .await
        .expect("shutdown must not wait for the blocked connection");
        assert_eq!(result.err().unwrap(), ServerManager::SHUTTING_DOWN);
    }

    #[tokio::test]
    async fn shutdown_cancels_in_flight_operations_and_rejects_unpolled_work() {
        let manager = ServerManager::default();
        let operation = manager.until_shutdown(std::future::pending::<Result<(), String>>());
        tokio::pin!(operation);
        std::future::poll_fn(|cx| {
            assert!(operation.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        manager.begin_shutdown();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), operation)
                .await
                .unwrap()
                .unwrap_err(),
            ServerManager::SHUTTING_DOWN
        );
        let result = manager
            .until_shutdown(async { panic!("shutdown work must not be polled") })
            .await;
        assert_eq!(
            result,
            Err::<(), _>(ServerManager::SHUTTING_DOWN.to_owned())
        );
        assert_eq!(
            manager.test_connection(&connection()).await.unwrap_err(),
            ServerManager::SHUTTING_DOWN
        );
    }

    #[tokio::test]
    async fn shutdown_preserves_cached_clients_for_teardown_then_drains_them() {
        let manager = ServerManager::default();
        let connection = connection();
        let (writer, _requests) = tokio::sync::mpsc::channel(1);
        let client = Arc::new(ServerClient {
            request_id: Default::default(),
            writer,
            pending: Default::default(),
            events: Default::default(),
            process: Mutex::new(None),
            closed: Default::default(),
        });
        manager.clients.lock().await.insert(
            connection.id.clone(),
            CachedServerClient {
                connection: connection.clone(),
                client: Arc::clone(&client),
            },
        );
        manager.begin_shutdown();
        assert!(Arc::ptr_eq(
            &client,
            &manager.client(&connection).await.unwrap()
        ));
        manager.stop_all().await;
        assert!(client.is_closed());
        assert!(manager.clients.lock().await.is_empty());
        assert_eq!(
            manager.client(&connection).await.err().unwrap(),
            ServerManager::SHUTTING_DOWN
        );
    }
}
