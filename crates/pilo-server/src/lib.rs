mod command;
mod environment;
mod fs_ops;
mod runtime_streams;
mod session;

use std::{
    collections::HashMap,
    io::{self, Read},
    path::Path,
    sync::{Arc, Mutex as StdMutex},
    time::Instant,
};

use command::command_run;
use environment::{ToolchainInfo, environment_inspect};
use fs_ops::{
    fs_mkdir, fs_mkdir_absolute, fs_read_dir, fs_read_file, fs_remove, fs_rename, fs_search,
    fs_stat, fs_write_file,
};
use pilo_protocol::{
    Envelope, MAX_BINARY_PAYLOAD_BYTES, PROTOCOL_VERSION, SERVER_CAPABILITIES, ServerHello,
    ServerStatus, read_frame, write_frame,
};
use runtime_streams::{
    PiProcess, TerminalSession, pi_send, pi_start, pi_stop, preview_ports, terminal_close,
    terminal_open, terminal_resize, terminal_write,
};
use serde::Deserialize;
use serde_json::{Value, json};
use session::{
    session_discover, session_read, session_scan, session_watch_start, session_watch_stop,
};
use tokio::{
    sync::{Mutex, OnceCell, Semaphore, mpsc},
    task::JoinHandle,
};

pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_IN_FLIGHT_REQUESTS: usize = 64;

pub fn binary_fingerprint(path: &Path) -> io::Result<String> {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    let mut file = std::fs::File::open(path)?;
    let mut hash = FNV_OFFSET;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }
    Ok(format!("{hash:016x}"))
}

#[derive(Clone)]
struct ServerState {
    writer: mpsc::Sender<Envelope>,
    request_slots: Arc<Semaphore>,
    started_at: Instant,
    pi: Arc<Mutex<HashMap<String, PiProcess>>>,
    session_watchers: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    terminals: Arc<StdMutex<HashMap<String, TerminalSession>>>,
    login_path: Arc<OnceCell<String>>,
    toolchain: Arc<OnceCell<ToolchainInfo>>,
}

pub async fn serve_stdio() -> Result<(), Box<dyn std::error::Error>> {
    let (writer_tx, mut writer_rx) = mpsc::channel::<Envelope>(256);
    let state = ServerState {
        writer: writer_tx,
        request_slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT_REQUESTS)),
        started_at: Instant::now(),
        pi: Arc::new(Mutex::new(HashMap::new())),
        session_watchers: Arc::new(Mutex::new(HashMap::new())),
        terminals: Arc::new(StdMutex::new(HashMap::new())),
        login_path: Arc::new(OnceCell::new()),
        toolchain: Arc::new(OnceCell::new()),
    };

    let writer_task = tokio::spawn(async move {
        let stdout = tokio::io::stdout();
        let mut stdout = stdout;
        while let Some(message) = writer_rx.recv().await {
            if write_frame(&mut stdout, message).await.is_err() {
                break;
            }
        }
    });

    let stdin = tokio::io::stdin();
    let mut stdin = stdin;
    while let Some(message) = read_frame(&mut stdin).await? {
        let Envelope::Request {
            id,
            method,
            params,
            binary,
        } = message
        else {
            continue;
        };
        let Ok(permit) = Arc::clone(&state.request_slots).acquire_owned().await else {
            break;
        };
        let state = state.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let response = match dispatch(&state, &method, params, binary).await {
                Ok(reply) => Envelope::response_with_binary(id, reply.value, reply.binary),
                Err(error) => Envelope::error(id, "request_failed", error),
            };
            let _ = state.writer.send(response).await;
        });
    }

    let mut pi = state.pi.lock().await;
    for (_, mut process) in pi.drain() {
        let _ = process.child.kill().await;
    }
    drop(pi);
    for (_, task) in state.session_watchers.lock().await.drain() {
        task.abort();
    }
    if let Ok(mut terminals) = state.terminals.lock() {
        for (_, mut terminal) in terminals.drain() {
            let _ = terminal.child.kill();
            let _ = terminal.child.wait();
        }
    }
    drop(state.writer);
    let _ = writer_task.await;
    Ok(())
}

struct ServerReply {
    value: Value,
    binary: Vec<Vec<u8>>,
}

impl ServerReply {
    fn json(value: Value) -> Self {
        Self {
            value,
            binary: Vec::new(),
        }
    }

    fn with_binary(value: Value, binary: Vec<Vec<u8>>) -> Self {
        Self { value, binary }
    }
}

async fn dispatch(
    state: &ServerState,
    method: &str,
    params: Value,
    binary: Vec<Vec<u8>>,
) -> Result<ServerReply, String> {
    if !matches!(method, "command.run" | "fs.write_file" | "terminal.write") && !binary.is_empty() {
        return Err(format!(
            "pilo-server method '{method}' does not accept binary attachments"
        ));
    }
    match method {
        "hello" => to_value(ServerHello {
            protocol_version: PROTOCOL_VERSION,
            server_version: SERVER_VERSION.to_owned(),
            os: std::env::consts::OS.to_owned(),
            arch: std::env::consts::ARCH.to_owned(),
            capabilities: SERVER_CAPABILITIES
                .iter()
                .map(|capability| (*capability).to_owned())
                .collect(),
        })
        .map(ServerReply::json),
        "server.ping" => Ok(ServerReply::json(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "serverVersion": SERVER_VERSION,
        }))),
        "server.status" => server_status(state).await.map(ServerReply::json),
        "environment.inspect" => environment_inspect(state, from_params(params)?)
            .await
            .map(ServerReply::json),
        "command.run" => {
            command_run(state, from_params(params)?, one_binary(binary, method)?).await
        }
        "fs.read_dir" => blocking(move || fs_read_dir(from_params(params)?))
            .await
            .map(ServerReply::json),
        "fs.read_file" => {
            let data = tokio::task::spawn_blocking(move || fs_read_file(from_params(params)?))
                .await
                .map_err(|error| format!("pilo-server blocking task failed: {error}"))??;
            Ok(ServerReply::with_binary(Value::Null, vec![data]))
        }
        "fs.write_file" => {
            let data = one_binary(binary, method)?;
            blocking(move || fs_write_file(from_params(params)?, data))
                .await
                .map(ServerReply::json)
        }
        "fs.stat" => blocking(move || fs_stat(from_params(params)?))
            .await
            .map(ServerReply::json),
        "fs.mkdir" => blocking(move || fs_mkdir(from_params(params)?))
            .await
            .map(ServerReply::json),
        "fs.mkdir_absolute" => blocking(move || fs_mkdir_absolute(from_params(params)?))
            .await
            .map(ServerReply::json),
        "fs.rename" => blocking(move || fs_rename(from_params(params)?))
            .await
            .map(ServerReply::json),
        "fs.remove" => blocking(move || fs_remove(from_params(params)?))
            .await
            .map(ServerReply::json),
        "fs.search" => blocking(move || fs_search(from_params(params)?))
            .await
            .map(ServerReply::json),
        "session.scan" => blocking(move || session_scan(from_params(params)?))
            .await
            .map(ServerReply::json),
        "session.read" => {
            let (metadata, data) =
                tokio::task::spawn_blocking(move || session_read(from_params(params)?))
                    .await
                    .map_err(|error| format!("pilo-server blocking task failed: {error}"))??;
            Ok(ServerReply::with_binary(metadata, vec![data]))
        }
        "session.discover" => blocking(session_discover).await.map(ServerReply::json),
        "session.watch_start" => session_watch_start(state, from_params(params)?)
            .await
            .map(ServerReply::json),
        "session.watch_stop" => session_watch_stop(state, from_params(params)?)
            .await
            .map(ServerReply::json),
        "preview.ports" => preview_ports().await.map(ServerReply::json),
        "terminal.open" => terminal_open(state, from_params(params)?)
            .await
            .map(ServerReply::json),
        "terminal.write" => {
            terminal_write(state, from_params(params)?, one_binary(binary, method)?)
                .await
                .map(ServerReply::json)
        }
        "terminal.resize" => terminal_resize(state, from_params(params)?)
            .await
            .map(ServerReply::json),
        "terminal.close" => terminal_close(state, from_params(params)?)
            .await
            .map(ServerReply::json),
        "pi.start" => pi_start(state, from_params(params)?)
            .await
            .map(ServerReply::json),
        "pi.send" => pi_send(state, from_params(params)?)
            .await
            .map(ServerReply::json),
        "pi.stop" => pi_stop(state, from_params(params)?)
            .await
            .map(ServerReply::json),
        _ => Err(format!("unknown pilo-server method '{method}'")),
    }
}

fn from_params<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|error| error.to_string())
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

fn one_binary(mut binary: Vec<Vec<u8>>, context: &str) -> Result<Vec<u8>, String> {
    if binary.len() != 1 {
        return Err(format!(
            "{context} expected exactly one binary attachment, got {}",
            binary.len()
        ));
    }
    let data = binary.remove(0);
    if data.len() > MAX_BINARY_PAYLOAD_BYTES {
        return Err(format!(
            "{context} binary attachment is {} bytes; pilo-server limit is {} bytes",
            data.len(),
            MAX_BINARY_PAYLOAD_BYTES
        ));
    }
    Ok(data)
}

async fn blocking<F>(operation: F) -> Result<Value, String>
where
    F: FnOnce() -> Result<Value, String> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| format!("pilo-server blocking task failed: {error}"))?
}

async fn server_status(state: &ServerState) -> Result<Value, String> {
    let pi_processes = state.pi.lock().await.len();
    let session_watchers = state.session_watchers.lock().await.len();
    let terminals = state
        .terminals
        .lock()
        .map_err(|_| "terminal registry is poisoned".to_owned())?
        .len();
    let uptime_ms = u64::try_from(state.started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
    let available_requests = state.request_slots.available_permits();
    to_value(ServerStatus {
        protocol_version: PROTOCOL_VERSION,
        server_version: SERVER_VERSION.to_owned(),
        pid: std::process::id(),
        uptime_ms,
        active_requests: MAX_IN_FLIGHT_REQUESTS.saturating_sub(available_requests),
        max_in_flight_requests: MAX_IN_FLIGHT_REQUESTS,
        pi_processes,
        terminals,
        session_watchers,
    })
}

#[cfg(test)]
mod tests;
