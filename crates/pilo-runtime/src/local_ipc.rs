//! Local Host IPC for same-user clients such as the `pilo` CLI.
//!
//! The Host binds a Unix socket or Windows named pipe derived from its App ID
//! (see [`pilo_ipc::endpoint`]). After the OS confirms the peer runs as the
//! current user, calls dispatch to the shared Host API as [`Principal::Local`].
//! No TCP listener, token or pairing is involved, and the Remote WebUI switch
//! has no effect on this endpoint.

use std::{sync::Arc, time::Duration};

use pilo_ipc::{
    ClientHello, Endpoint, FrameError, HELLO_TIMEOUT, HostHello, Installation, PROTOCOL_VERSION,
    error_code, protocol_compatible, read_frame, write_frame,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{Semaphore, watch},
    task::JoinHandle,
};

use crate::{
    Runtime,
    handle::WeakRuntime,
    host_api::{self, MethodKind, Principal},
    storage,
};

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

/// Concurrent client connections; further clients wait for a free slot.
const MAX_CONNECTIONS: usize = 32;

/// Lifecycle methods owned by the desktop shell, never callable over IPC.
const SHELL_ONLY_METHODS: &[&str] = &["host.shutdown"];

#[derive(Clone, Debug)]
pub struct LocalIpcConfig {
    pub app_id: String,
    pub app_version: String,
    pub installation: Option<Installation>,
}

/// A running endpoint. Dropping it stops accepting and removes the socket.
pub struct LocalIpcServer {
    endpoint: Endpoint,
    shutdown: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
}

impl LocalIpcServer {
    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// Stops accepting connections and waits until the endpoint is released.
    pub async fn stop(mut self) {
        let _ = self.shutdown.send(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for LocalIpcServer {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
    }
}

struct Shared {
    runtime: WeakRuntime,
    hello: HostHello,
    connections: Semaphore,
}

impl Runtime {
    /// Binds the endpoint for `config.app_id` and the current OS user; it stays
    /// open until [`Runtime::shutdown`].
    pub async fn start_local_ipc(&self, config: LocalIpcConfig) -> Result<Endpoint, String> {
        let endpoint = Endpoint::current(&config.app_id)?;
        let mut slot = self.local_ipc.lock().await;
        if slot.is_some() {
            return Err("local IPC is already running".to_owned());
        }
        let server = self.start_local_ipc_at(endpoint.clone(), config).await?;
        *slot = Some(server);
        Ok(endpoint)
    }

    /// Binds an explicit endpoint; tests use private directories.
    pub async fn start_local_ipc_at(
        &self,
        endpoint: Endpoint,
        config: LocalIpcConfig,
    ) -> Result<LocalIpcServer, String> {
        pilo_ipc::validate_app_id(&config.app_id)?;
        let paths = self.paths.clone();
        let host_id = tokio::task::spawn_blocking(move || {
            storage::get_or_create_host_id(&storage::open_with_paths(&paths)?)
        })
        .await
        .map_err(|error| format!("failed to read the Host ID: {error}"))??;
        let capabilities = serde_json::to_value(crate::remote::api::v2::host_capabilities())
            .map_err(|error| error.to_string())?;
        let shared = Arc::new(Shared {
            runtime: self.downgrade(),
            hello: HostHello {
                protocol: PROTOCOL_VERSION.to_owned(),
                host_id,
                app_version: config.app_version,
                capabilities,
                installation: config.installation,
            },
            connections: Semaphore::new(MAX_CONNECTIONS),
        });
        let (shutdown, stopped) = watch::channel(false);
        let task = match &endpoint {
            #[cfg(unix)]
            Endpoint::Unix(unix_endpoint) => unix::listen(unix_endpoint, shared, stopped)?,
            #[cfg(windows)]
            Endpoint::NamedPipe(name) => windows::listen(name, shared, stopped)?,
            #[allow(unreachable_patterns)]
            _ => return Err(format!("unsupported IPC endpoint {endpoint}")),
        };
        log::info!(target: "local-ipc", "listening on {endpoint}");
        Ok(LocalIpcServer {
            endpoint,
            shutdown,
            task: Some(task),
        })
    }
}

/// Runs the hello exchange and then answers requests in order until EOF.
async fn serve<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, shared: Arc<Shared>) {
    let hello = tokio::time::timeout(HELLO_TIMEOUT, read_frame(&mut stream)).await;
    let reply = match hello {
        Err(_) => return,
        Ok(Ok(None)) => return,
        Ok(Err(error)) => {
            let _ = write_frame(&mut stream, &frame_error(None, &error)).await;
            return;
        }
        Ok(Ok(Some(frame))) => match serde_json::from_value::<ClientHello>(frame) {
            Err(error) => {
                let _ = write_frame(
                    &mut stream,
                    &error_frame(None, "invalid_params", &format!("invalid hello: {error}")),
                )
                .await;
                return;
            }
            Ok(hello) if !protocol_compatible(PROTOCOL_VERSION, &hello.protocol) => {
                let message = format!(
                    "Host speaks protocol {PROTOCOL_VERSION}, client '{}' {} speaks {}",
                    hello.client, hello.version, hello.protocol
                );
                let _ = write_frame(
                    &mut stream,
                    &error_frame(None, error_code::INCOMPATIBLE_PROTOCOL, &message),
                )
                .await;
                return;
            }
            Ok(_) => json!({ "result": shared.hello }),
        },
    };
    if tokio::time::timeout(HELLO_TIMEOUT, write_frame(&mut stream, &reply))
        .await
        .map_or(true, |result| result.is_err())
    {
        return;
    }
    loop {
        let frame = match read_frame(&mut stream).await {
            Ok(Some(frame)) => frame,
            Ok(None) => return,
            Err(error) => {
                // A torn or oversized frame leaves the stream unframed; reply once and close.
                let _ = write_frame(&mut stream, &frame_error(None, &error)).await;
                return;
            }
        };
        let response = respond(&shared, frame).await;
        if write_frame(&mut stream, &response).await.is_err() {
            return;
        }
    }
}

async fn respond(shared: &Shared, frame: Value) -> Value {
    let id = frame
        .get("id")
        .cloned()
        .filter(|id| id.is_string() || id.is_number());
    let Some(id) = id else {
        return error_frame(
            None,
            "invalid_params",
            "request requires a string or number id",
        );
    };
    let Some(method) = frame
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return error_frame(Some(id), "invalid_params", "request requires a method");
    };
    let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));
    let Some(spec) = host_api::methods().iter().find(|spec| spec.name == method) else {
        return error_frame(
            Some(id),
            "not_found",
            &format!("Unknown Host API method '{method}'"),
        );
    };
    if spec.kind != MethodKind::Json || SHELL_ONLY_METHODS.contains(&spec.name) {
        return error_frame(
            Some(id),
            error_code::UNSUPPORTED_METHOD,
            &format!("'{method}' is not available over local IPC"),
        );
    }
    let Ok(runtime) = shared.runtime.upgrade() else {
        return error_frame(Some(id), "unavailable", "Pilo Host is shutting down");
    };
    // Finish the call even if the client disconnects: a cancelled write could
    // otherwise leave its outcome unknown on the Host side as well.
    let call =
        tokio::spawn(
            async move { host_api::call(&runtime, &Principal::Local, &method, params).await },
        );
    match call.await {
        Ok(Ok(result)) => json!({ "id": id, "result": result }),
        Ok(Err(error)) => json!({ "id": id, "error": error }),
        Err(error) => error_frame(Some(id), "internal", &format!("Host call failed: {error}")),
    }
}

fn frame_error(id: Option<Value>, error: &FrameError) -> Value {
    error_frame(id, error_code::INVALID_FRAME, &error.to_string())
}

fn error_frame(id: Option<Value>, code: &str, message: &str) -> Value {
    let error = json!({ "code": code, "message": message, "retryable": false });
    match id {
        Some(id) => json!({ "id": id, "error": error }),
        None => json!({ "error": error }),
    }
}

async fn wait_stopped(stopped: &mut watch::Receiver<bool>) {
    while !*stopped.borrow() {
        if stopped.changed().await.is_err() {
            return;
        }
    }
}

/// Grace period for in-flight connections when the endpoint stops.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(all(test, unix))]
mod tests;
