mod manager;
#[cfg(test)]
mod tests;
mod transport;

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use pilo_protocol::{Envelope, PROTOCOL_VERSION, SERVER_CAPABILITIES, ServerPing};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::domain::Connection;

use super::{
    connection_diagnostics::{ConnectionDiagnostics, request_failure_reason},
    server_deploy::{SpawnedServer, spawn_server},
};
use transport::{
    PendingRequest, PendingRequestGuard, PendingRequests, ServerEventHub, ServerProcess,
    ServerResponse, fail_pending, reader_loop, writer_loop,
};

pub(crate) use manager::ServerManager;
pub use transport::{SERVER_DISCONNECTED_EVENT, ServerEventReceiver};

const REQUEST_CAPACITY: usize = 256;
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(75);

pub struct ServerClient {
    request_id: AtomicU64,
    writer: mpsc::Sender<Envelope>,
    pending: PendingRequests,
    events: Arc<ServerEventHub>,
    process: Mutex<Option<ServerProcess>>,
    closed: Arc<AtomicBool>,
}

impl ServerClient {
    async fn connect(connection: &Connection, persistent: bool) -> Result<Arc<Self>, String> {
        let diagnostics = ConnectionDiagnostics::new(connection);
        diagnostics
            .stage("connect")
            .finish(Self::connect_with_diagnostics(connection, &diagnostics, persistent).await)
    }

    async fn connect_with_diagnostics(
        connection: &Connection,
        diagnostics: &ConnectionDiagnostics,
        persistent: bool,
    ) -> Result<Arc<Self>, String> {
        let attempt_id = diagnostics.attempt_id;
        // The remote deployment is content-addressed, so a reused binary always
        // fingerprints like the current build. If hello still reports a protocol
        // mismatch, another Pilo version replaced the file between the deploy
        // check and spawn; one forced redeploy resolves that race.
        let mut force_redeploy = false;
        log::info!(target: "pilo-server", "connect begin connectionId={}", connection.id);
        loop {
            let SpawnedServer {
                child,
                stdin,
                stdout,
                mut stderr,
                reused_deployment,
            } = diagnostics
                .stage("prepare_server")
                .finish(spawn_server(connection, force_redeploy, diagnostics, persistent).await)?;
            let (writer_tx, writer_rx) = mpsc::channel(REQUEST_CAPACITY);
            let events = Arc::new(ServerEventHub::default());
            let pending = Arc::new(Mutex::new(HashMap::new()));
            let closed = Arc::new(AtomicBool::new(false));

            let launcher_pid = child.id();
            log::info!(target: "pilo-server", "spawned attemptId={attempt_id} connectionId={} launcherPid={launcher_pid:?} reused={reused_deployment}", connection.id);
            let writer_task = tokio::spawn(writer_loop(
                stdin,
                writer_rx,
                Arc::clone(&pending),
                Arc::clone(&events),
                Arc::clone(&closed),
            ));
            let read_pending = Arc::clone(&pending);
            let read_events = Arc::clone(&events);
            let read_closed = Arc::clone(&closed);
            let connection_id = connection.id.clone();
            let reader_task = tokio::spawn(async move {
                reader_loop(stdout, read_pending, read_events, Arc::clone(&read_closed)).await;
                log::info!(target: "pilo-server", "reader ended attemptId={attempt_id} connectionId={connection_id} launcherPid={launcher_pid:?} closed={}", read_closed.load(Ordering::Acquire));
            });
            let label = connection.name.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0_u8; 4096];
                loop {
                    match tokio::io::AsyncReadExt::read(&mut stderr, &mut buffer).await {
                        Ok(0) => break,
                        Err(error) => {
                            log::warn!(target: "connection-diagnostics", "stderr read failed attemptId={attempt_id} launcherPid={launcher_pid:?} kind={:?} osCode={:?}", error.kind(), error.raw_os_error());
                            break;
                        }
                        Ok(read) => log::warn!(
                            target: "pilo-server",
                            "[{label}] attemptId={attempt_id} {}",
                            String::from_utf8_lossy(&buffer[..read]).trim_end()
                        ),
                    }
                }
            });

            let client = Arc::new(Self {
                request_id: AtomicU64::new(1),
                writer: writer_tx,
                pending,
                events,
                process: Mutex::new(Some(ServerProcess {
                    child,
                    writer_task,
                    reader_task,
                })),
                closed,
            });
            let handshake = diagnostics.stage("handshake");
            let ping: ServerPing = match client
                .request_typed_with_timeout("server.ping", Value::Null, HANDSHAKE_TIMEOUT)
                .await
            {
                Ok(ping) => ping,
                Err(error) => return handshake.finish(Err(error)),
            };
            if ping.protocol_version != PROTOCOL_VERSION {
                let result = handshake.finish(Err(format!(
                    "pilo-server protocol mismatch: expected {PROTOCOL_VERSION}, got {}",
                    ping.protocol_version
                )));
                client.stop().await;
                if reused_deployment && !force_redeploy {
                    log::warn!(target: "connection-diagnostics", "redeploy retry attemptId={attempt_id} expectedProtocol={PROTOCOL_VERSION} actualProtocol={}", ping.protocol_version);
                    force_redeploy = true;
                    continue;
                }
                return result;
            }
            let missing_capabilities = SERVER_CAPABILITIES
                .iter()
                .copied()
                .filter(|capability| {
                    !ping
                        .capabilities
                        .iter()
                        .any(|available| available == capability)
                })
                .collect::<Vec<_>>();
            if !missing_capabilities.is_empty() {
                client.stop().await;
                let recovery = if cfg!(debug_assertions) {
                    "rebuild the development runtime with pnpm server:build for the connection's platform in the checkout running Pilo, then restart Pilo"
                } else {
                    "update or reinstall Pilo so the bundled runtime matches the app"
                };
                return handshake.finish(Err(format!(
                    "pilo-server is missing required capabilities: {}; {recovery}. Also check PILO_SERVER_PATH and PILO_SERVER_LINUX_PATH overrides",
                    missing_capabilities.join(", ")
                )));
            }
            handshake.finish(Ok(()))?;
            log::info!(target: "pilo-server", "connected attemptId={attempt_id} connectionId={} launcherPid={launcher_pid:?} version={} protocol={}", connection.id, ping.server_version, ping.protocol_version);
            return Ok(client);
        }
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let started = std::time::Instant::now();
        let response = self
            .request_raw_with_timeout(method, params, Vec::new(), REQUEST_TIMEOUT)
            .await?;
        if !response.binary.is_empty() {
            let error =
                format!("pilo-server method '{method}' returned unexpected binary attachments");
            self.log_request_failure(method, None, started, &error)
                .await;
            return Err(error);
        }
        Ok(response.value)
    }

    pub async fn request_with_binary(
        &self,
        method: &str,
        params: Value,
        binary: Vec<Vec<u8>>,
    ) -> Result<(Value, Vec<Vec<u8>>), String> {
        let response = self
            .request_raw_with_timeout(method, params, binary, REQUEST_TIMEOUT)
            .await?;
        Ok((response.value, response.binary))
    }

    async fn request_raw_with_timeout(
        &self,
        method: &str,
        params: Value,
        binary: Vec<Vec<u8>>,
        timeout: std::time::Duration,
    ) -> Result<ServerResponse, String> {
        let started = std::time::Instant::now();
        if self.is_closed() {
            let error = "pilo-server connection is closed".to_owned();
            self.log_request_failure(method, None, started, &error)
                .await;
            return Err(error);
        }
        let id = self.request_id.fetch_add(1, Ordering::Relaxed);
        let stream_id = params
            .get("streamId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let command_type = params
            .pointer("/command/type")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let command_id = params
            .pointer("/command/id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let trace_request = matches!(method, "pi.start" | "pi.send" | "pi.stop" | "server.ping");
        if trace_request {
            log::info!(target: "pilo-server", "request begin requestId={id} method={method} streamId={stream_id:?} command={command_type:?} rpcId={command_id:?} writerCapacity={}", self.writer.capacity());
        }
        let (reply_tx, reply_rx) = oneshot::channel();
        self.pending
            .lock()
            .await
            .insert(id, PendingRequest { reply: reply_tx });
        let _pending_guard = PendingRequestGuard {
            pending: Arc::clone(&self.pending),
            id,
        };
        if self.is_closed() {
            self.pending.lock().await.remove(&id);
            let error = "pilo-server connection is closed".to_owned();
            self.log_request_failure(method, Some(id), started, &error)
                .await;
            return Err(error);
        }
        if self
            .writer
            .send(Envelope::request_with_binary(id, method, params, binary))
            .await
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            let error = "pilo-server connection is closed".to_owned();
            self.log_request_failure(method, Some(id), started, &error)
                .await;
            return Err(error);
        }
        let enqueue_ms = started.elapsed().as_millis();
        let result = match tokio::time::timeout(timeout, reply_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("pilo-server response channel closed".to_owned()),
            Err(_) => {
                let pending_count = {
                    let mut pending = self.pending.lock().await;
                    pending.remove(&id);
                    pending.len()
                };
                let launcher_pid = self
                    .process
                    .lock()
                    .await
                    .as_ref()
                    .and_then(|process| process.child.id());
                log::warn!(target: "pilo-server", "request timeout launcherPid={launcher_pid:?} requestId={id} method={method} streamId={stream_id:?} command={command_type:?} rpcId={command_id:?} elapsedMs={} timeoutMs={} pendingRequests={pending_count} writerCapacity={} closed={}", started.elapsed().as_millis(), timeout.as_millis(), self.writer.capacity(), self.is_closed());
                Err(format!("pilo-server request '{method}' timed out"))
            }
        };
        if trace_request {
            log::info!(target: "pilo-server", "request end requestId={id} method={method} streamId={stream_id:?} rpcId={command_id:?} ok={} elapsedMs={} enqueueMs={enqueue_ms}", result.is_ok(), started.elapsed().as_millis());
        }
        if let Err(error) = &result {
            self.log_request_failure(method, Some(id), started, error)
                .await;
        }
        result
    }

    async fn log_request_failure(
        &self,
        method: &str,
        request_id: Option<u64>,
        started: std::time::Instant,
        error: &str,
    ) {
        // Watcher retries have their own contextual, rate-limited summary.
        if method == "session.watch_start"
            || error == format!("pilo-server request '{method}' timed out")
        {
            return;
        }
        let Some(reason) = request_failure_reason(method, error) else {
            return;
        };
        let launcher_pid = self
            .process
            .lock()
            .await
            .as_ref()
            .and_then(|process| process.child.id());
        log::warn!(target: "pilo-server", "request failed pid={} launcherPid={launcher_pid:?} requestId={request_id:?} method={method:?} elapsedMs={} reason={reason}", std::process::id(), started.elapsed().as_millis());
    }

    async fn request_typed_with_timeout<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
        timeout: std::time::Duration,
    ) -> Result<T, String> {
        let response = self
            .request_raw_with_timeout(method, params, Vec::new(), timeout)
            .await?;
        if !response.binary.is_empty() {
            return Err(format!(
                "pilo-server method '{method}' returned unexpected binary attachments"
            ));
        }
        serde_json::from_value(response.value)
            .map_err(|error| format!("invalid pilo-server response for {method}: {error}"))
    }

    pub fn subscribe(&self, stream_id: &str) -> ServerEventReceiver {
        self.events.subscribe(stream_id)
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    async fn stop(&self) {
        self.closed.store(true, Ordering::Release);
        fail_pending(&self.pending, "pilo-server stopped").await;
        let Some(mut process) = self.process.lock().await.take() else {
            return;
        };
        let launcher_pid = process.child.id();
        log::info!(target: "pilo-server", "stop begin launcherPid={launcher_pid:?}");
        // Closing stdin lets pilo-server stop its Pi/PTY children on EOF. Killing
        // the server first bypasses that cleanup and can orphan those processes.
        process.writer_task.abort();
        let _ = process.writer_task.await;
        if tokio::time::timeout(std::time::Duration::from_secs(5), process.child.wait())
            .await
            .is_err()
        {
            log::warn!(target: "pilo-server", "graceful stop timed out launcherPid={launcher_pid:?}; killing server");
            let _ = process.child.start_kill();
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(1), process.child.wait()).await;
        }
        process.reader_task.abort();
        log::info!(target: "pilo-server", "stop end launcherPid={launcher_pid:?}");
    }
}
