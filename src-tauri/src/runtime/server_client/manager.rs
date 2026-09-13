use std::{collections::HashMap, sync::Arc};

use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::domain::Connection;

use super::ServerClient;

pub(super) fn retryable_read_method(method: &str) -> bool {
    matches!(
        method,
        "server.ping"
            | "server.status"
            | "environment.inspect"
            | "fs.read_dir"
            | "fs.read_file"
            | "fs.stat"
            | "fs.search"
            | "session.scan"
            | "session.read"
            | "session.discover"
            | "preview.ports"
    )
}

#[derive(Default)]
pub struct ServerManager {
    clients: Mutex<HashMap<String, Arc<ServerClient>>>,
    connection_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl ServerManager {
    pub async fn client(&self, connection: &Connection) -> Result<Arc<ServerClient>, String> {
        if let Some(client) = self.cached_client(&connection.id).await {
            return Ok(client);
        }

        let connection_lock = {
            let mut locks = self.connection_locks.lock().await;
            Arc::clone(
                locks
                    .entry(connection.id.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let _connection_guard = connection_lock.lock().await;
        if let Some(client) = self.cached_client(&connection.id).await {
            return Ok(client);
        }

        let client = ServerClient::connect(connection).await?;
        self.clients
            .lock()
            .await
            .insert(connection.id.clone(), Arc::clone(&client));
        Ok(client)
    }

    async fn cached_client(&self, connection_id: &str) -> Option<Arc<ServerClient>> {
        let stale = {
            let mut clients = self.clients.lock().await;
            match clients.get(connection_id).cloned() {
                Some(client) if !client.is_closed() => return Some(client),
                Some(_) => clients.remove(connection_id),
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
                Some(current) if Arc::ptr_eq(current, failed) => clients.remove(connection_id),
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
        let client = self.client(connection).await?;
        let retry_params =
            (retryable_read_method(method) && binary.is_empty()).then(|| params.clone());
        match client.request_with_binary(method, params, binary).await {
            Ok(response) => Ok(response),
            Err(error) if retry_params.is_some() && client.is_closed() => {
                self.invalidate_client(&connection.id, &client).await;
                let retry_client = self.client(connection).await?;
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
            return Err(format!(
                "pilo-server method '{method}' returned unexpected binary attachments"
            ));
        }
        Ok(value)
    }

    pub async fn test_connection(&self, connection: &Connection) -> Result<Value, String> {
        let client = ServerClient::connect(connection).await?;
        let result = client.request("server.ping", Value::Null).await;
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
        serde_json::from_value(self.request(connection, method, params).await?)
            .map_err(|error| format!("invalid pilo-server response for {method}: {error}"))
    }

    pub async fn stop_all(&self) {
        let clients = self
            .clients
            .lock()
            .await
            .drain()
            .map(|(_, client)| client)
            .collect::<Vec<_>>();
        for client in clients {
            client.stop().await;
        }
    }
}
