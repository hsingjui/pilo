use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use pilo_protocol::{
    Envelope, PROTOCOL_VERSION, SERVER_CAPABILITIES, ServerHello, read_frame, write_frame,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    sync::{Mutex, OnceCell, broadcast, mpsc, oneshot},
    task::JoinHandle,
};

use crate::domain::{Connection, ConnectionKind, SshTarget};

use super::ssh::{ssh_base_args, wrap_posix_script};

const SERVER_REMOTE_DIR: &str = ".cache/pilo/server-v3";
const REQUEST_CAPACITY: usize = 256;
const STREAM_EVENT_CAPACITY: usize = 512;
const HELLO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(75);
pub const SERVER_DISCONNECTED_EVENT: &str = "server.disconnected";

struct ServerResponse {
    value: Value,
    binary: Vec<Vec<u8>>,
}

struct PendingRequest {
    reply: oneshot::Sender<Result<ServerResponse, String>>,
}

type PendingRequests = Arc<Mutex<HashMap<u64, PendingRequest>>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum ServerPlatform {
    Windows,
    Linux,
    Darwin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum ServerArch {
    X86_64,
    Aarch64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct ServerTarget {
    platform: ServerPlatform,
    arch: ServerArch,
}

impl ServerTarget {
    fn resource_name(self) -> &'static str {
        match (self.platform, self.arch) {
            (ServerPlatform::Windows, ServerArch::X86_64) => "pilo-server-windows-x86_64.exe",
            (ServerPlatform::Windows, ServerArch::Aarch64) => "pilo-server-windows-aarch64.exe",
            (ServerPlatform::Linux, ServerArch::X86_64) => "pilo-server-linux-x86_64",
            (ServerPlatform::Linux, ServerArch::Aarch64) => "pilo-server-linux-aarch64",
            (ServerPlatform::Darwin, ServerArch::X86_64) => "pilo-server-darwin-x86_64",
            (ServerPlatform::Darwin, ServerArch::Aarch64) => "pilo-server-darwin-aarch64",
        }
    }

    fn from_uname(os: &str, arch: &str) -> Result<Self, String> {
        let platform = match os.trim().to_ascii_lowercase().as_str() {
            "linux" => ServerPlatform::Linux,
            "darwin" => ServerPlatform::Darwin,
            other => {
                return Err(format!(
                    "remote operating system '{other}' is not supported"
                ));
            }
        };
        let arch = parse_server_arch(arch)?;
        Ok(Self { platform, arch })
    }

    fn current() -> Result<Self, String> {
        let platform = if cfg!(target_os = "windows") {
            ServerPlatform::Windows
        } else if cfg!(target_os = "linux") {
            ServerPlatform::Linux
        } else if cfg!(target_os = "macos") {
            ServerPlatform::Darwin
        } else {
            return Err(format!(
                "Pilo server is not bundled for host operating system '{}'",
                std::env::consts::OS
            ));
        };
        let arch = parse_server_arch(std::env::consts::ARCH)?;
        Ok(Self { platform, arch })
    }
}

fn parse_server_arch(arch: &str) -> Result<ServerArch, String> {
    match arch.trim().to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" | "x64" => Ok(ServerArch::X86_64),
        "aarch64" | "arm64" => Ok(ServerArch::Aarch64),
        other => Err(format!("server architecture '{other}' is not supported")),
    }
}

struct ServerArtifact {
    path: PathBuf,
    fingerprint: String,
    size: u64,
}

static SERVER_ARTIFACTS: OnceCell<Mutex<HashMap<ServerTarget, Arc<ServerArtifact>>>> =
    OnceCell::const_new();

#[derive(Clone, Debug)]
pub struct ServerEvent {
    pub stream_id: String,
    pub event: String,
    pub data: Value,
    pub binary: Vec<Vec<u8>>,
}

#[derive(Default)]
struct ServerEventHub {
    streams: StdMutex<HashMap<String, broadcast::Sender<ServerEvent>>>,
}

impl ServerEventHub {
    fn subscribe(&self, stream_id: &str) -> broadcast::Receiver<ServerEvent> {
        let mut streams = self
            .streams
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        streams.retain(|_, sender| sender.receiver_count() > 0);
        streams
            .entry(stream_id.to_owned())
            .or_insert_with(|| broadcast::channel(STREAM_EVENT_CAPACITY).0)
            .subscribe()
    }

    fn send(&self, event: ServerEvent) {
        let sender = {
            let mut streams = self
                .streams
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let Some(sender) = streams.get(&event.stream_id).cloned() else {
                return;
            };
            if sender.receiver_count() == 0 {
                streams.remove(&event.stream_id);
                return;
            }
            sender
        };
        let _ = sender.send(event);
    }

    fn disconnect(&self, message: String) {
        let event = ServerEvent {
            stream_id: String::new(),
            event: SERVER_DISCONNECTED_EVENT.to_owned(),
            data: json!({ "message": message }),
            binary: Vec::new(),
        };
        let senders = {
            let mut streams = self
                .streams
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            streams.retain(|_, sender| sender.receiver_count() > 0);
            streams.values().cloned().collect::<Vec<_>>()
        };
        for sender in senders {
            let _ = sender.send(event.clone());
        }
    }
}

struct ServerProcess {
    child: Child,
    writer_task: JoinHandle<()>,
    reader_task: JoinHandle<()>,
}

struct SpawnedServer {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr: ChildStderr,
}

pub struct ServerClient {
    request_id: AtomicU64,
    writer: mpsc::Sender<Envelope>,
    pending: PendingRequests,
    events: Arc<ServerEventHub>,
    process: Mutex<Option<ServerProcess>>,
    closed: Arc<AtomicBool>,
}

impl ServerClient {
    async fn connect(connection: &Connection) -> Result<Arc<Self>, String> {
        let SpawnedServer {
            child,
            stdin,
            stdout,
            mut stderr,
        } = spawn_server(connection).await?;
        let (writer_tx, writer_rx) = mpsc::channel(REQUEST_CAPACITY);
        let events = Arc::new(ServerEventHub::default());
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));

        let writer_task = tokio::spawn(writer_loop(
            stdin,
            writer_rx,
            Arc::clone(&pending),
            Arc::clone(&events),
            Arc::clone(&closed),
        ));
        let reader_task = tokio::spawn(reader_loop(
            stdout,
            Arc::clone(&pending),
            Arc::clone(&events),
            Arc::clone(&closed),
        ));
        let label = connection.name.clone();
        tokio::spawn(async move {
            let mut buffer = vec![0_u8; 4096];
            loop {
                match tokio::io::AsyncReadExt::read(&mut stderr, &mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => eprintln!(
                        "[pilo-server:{label}] {}",
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
        let hello: ServerHello = client
            .request_typed_with_timeout("hello", Value::Null, HELLO_TIMEOUT)
            .await?;
        if hello.protocol_version != PROTOCOL_VERSION {
            client.stop().await;
            return Err(format!(
                "pilo-server protocol mismatch: expected {PROTOCOL_VERSION}, got {}",
                hello.protocol_version
            ));
        }
        let missing_capabilities = SERVER_CAPABILITIES
            .iter()
            .copied()
            .filter(|capability| {
                !hello
                    .capabilities
                    .iter()
                    .any(|available| available == capability)
            })
            .collect::<Vec<_>>();
        if !missing_capabilities.is_empty() {
            client.stop().await;
            return Err(format!(
                "pilo-server is missing required capabilities: {}",
                missing_capabilities.join(", ")
            ));
        }
        Ok(client)
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let response = self
            .request_raw_with_timeout(method, params, Vec::new(), REQUEST_TIMEOUT)
            .await?;
        if !response.binary.is_empty() {
            return Err(format!(
                "pilo-server method '{method}' returned unexpected binary attachments"
            ));
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
        if self.is_closed() {
            return Err("pilo-server connection is closed".to_owned());
        }
        let id = self.request_id.fetch_add(1, Ordering::Relaxed);
        let (reply_tx, reply_rx) = oneshot::channel();
        self.pending
            .lock()
            .await
            .insert(id, PendingRequest { reply: reply_tx });
        if self.is_closed() {
            self.pending.lock().await.remove(&id);
            return Err("pilo-server connection is closed".to_owned());
        }
        if self
            .writer
            .send(Envelope::request_with_binary(id, method, params, binary))
            .await
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            return Err("pilo-server connection is closed".to_owned());
        }
        match tokio::time::timeout(timeout, reply_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("pilo-server response channel closed".to_owned()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("pilo-server request '{method}' timed out"))
            }
        }
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

    pub fn subscribe(&self, stream_id: &str) -> broadcast::Receiver<ServerEvent> {
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
        process.writer_task.abort();
        process.reader_task.abort();
        let _ = process.child.kill().await;
        let _ = process.child.wait().await;
    }
}

async fn writer_loop(
    mut stdin: ChildStdin,
    mut requests: mpsc::Receiver<Envelope>,
    pending: PendingRequests,
    events: Arc<ServerEventHub>,
    closed: Arc<AtomicBool>,
) {
    while let Some(request) = requests.recv().await {
        if let Err(error) = write_frame(&mut stdin, &request).await {
            if matches!(
                error.kind(),
                std::io::ErrorKind::InvalidInput | std::io::ErrorKind::InvalidData
            ) {
                if let Envelope::Request { id, .. } = request
                    && let Some(pending) = pending.lock().await.remove(&id)
                {
                    let _ = pending
                        .reply
                        .send(Err(format!("pilo-server request is invalid: {error}")));
                }
                continue;
            }
            mark_disconnected(
                &pending,
                &events,
                &closed,
                format!("pilo-server write failed: {error}"),
            )
            .await;
            break;
        }
    }
}

async fn reader_loop(
    mut stdout: BufReader<ChildStdout>,
    pending: PendingRequests,
    events: Arc<ServerEventHub>,
    closed: Arc<AtomicBool>,
) {
    let reason = loop {
        match read_frame(&mut stdout).await {
            Ok(Some(Envelope::Response {
                id,
                result,
                binary,
                error,
            })) => {
                if let Some(pending) = pending.lock().await.remove(&id) {
                    let response = match error {
                        Some(error) => Err(error.message),
                        None => Ok(ServerResponse {
                            value: result.unwrap_or(Value::Null),
                            binary,
                        }),
                    };
                    let _ = pending.reply.send(response);
                }
            }
            Ok(Some(Envelope::Event {
                stream_id,
                event,
                data,
                binary,
            })) => {
                events.send(ServerEvent {
                    stream_id,
                    event,
                    data,
                    binary,
                });
            }
            Ok(Some(Envelope::Request { .. })) => {}
            Ok(None) => break "pilo-server disconnected".to_owned(),
            Err(error) => break format!("pilo-server protocol read failed: {error}"),
        }
    };
    mark_disconnected(&pending, &events, &closed, reason).await;
}

async fn mark_disconnected(
    pending: &PendingRequests,
    events: &ServerEventHub,
    closed: &AtomicBool,
    message: String,
) {
    if closed.swap(true, Ordering::AcqRel) {
        return;
    }
    events.disconnect(message.clone());
    fail_pending(pending, &message).await;
}

async fn fail_pending(pending: &PendingRequests, message: &str) {
    let mut pending = pending.lock().await;
    for (_, pending) in pending.drain() {
        let _ = pending.reply.send(Err(message.to_owned()));
    }
}

fn retryable_read_method(method: &str) -> bool {
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

async fn spawn_server(connection: &Connection) -> Result<SpawnedServer, String> {
    match &connection.kind {
        ConnectionKind::Local => {
            let target = ServerTarget::current()?;
            let command = match server_binary(target) {
                Ok(path) => Command::new(path),
                Err(error) if cfg!(debug_assertions) => {
                    eprintln!("[pilo-server:local] {error}; using embedded debug fallback");
                    let executable = std::env::current_exe()
                        .map_err(|error| format!("failed to locate Pilo executable: {error}"))?;
                    let mut command = Command::new(executable);
                    command.arg("--pilo-server");
                    command
                }
                Err(error) => return Err(error),
            };
            spawn_piped_server(command, &connection.name)
        }
        ConnectionKind::Wsl { .. } => spawn_wsl_server(connection).await,
        ConnectionKind::Ssh { .. } => spawn_ssh_server(connection).await,
    }
}

async fn spawn_wsl_server(connection: &Connection) -> Result<SpawnedServer, String> {
    let ConnectionKind::Wsl { distro } = &connection.kind else {
        return Err("WSL pilo-server spawn requires a WSL connection".to_owned());
    };
    let target = probe_wsl_target(distro).await?;
    let remote_path = deploy_server(connection, target).await?;
    let mut command = Command::new("wsl.exe");
    command.args([
        "--distribution",
        distro,
        "--exec",
        "/bin/sh",
        "-c",
        &format!("exec \"$HOME/{remote_path}\""),
    ]);
    spawn_piped_server(command, &connection.name)
}

async fn spawn_ssh_server(connection: &Connection) -> Result<SpawnedServer, String> {
    let ConnectionKind::Ssh { target } = &connection.kind else {
        return Err("SSH pilo-server spawn requires an SSH connection".to_owned());
    };
    let server_target = probe_ssh_target(target).await?;
    let remote_path = deploy_server(connection, server_target).await?;
    let mut args = ssh_base_args(target)?;
    args.push(wrap_posix_script(&format!("exec \"$HOME/{remote_path}\"")));
    let mut command = Command::new("ssh");
    command.args(args);
    spawn_piped_server(command, &connection.name)
}

fn spawn_piped_server(mut command: Command, label: &str) -> Result<SpawnedServer, String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start pilo-server for '{label}': {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "pilo-server stdin unavailable".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "pilo-server stdout unavailable".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "pilo-server stderr unavailable".to_owned())?;
    Ok(SpawnedServer {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        stderr,
    })
}

fn parse_target_probe(output: &[u8], label: &str) -> Result<ServerTarget, String> {
    let output = String::from_utf8_lossy(output);
    let (os, arch) = output.trim().split_once('\t').ok_or_else(|| {
        format!(
            "invalid {label} platform probe response: '{}'",
            output.trim()
        )
    })?;
    ServerTarget::from_uname(os, arch)
}

async fn probe_wsl_target(distro: &str) -> Result<ServerTarget, String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        Command::new("wsl.exe")
            .args([
                "--distribution",
                distro,
                "--exec",
                "/bin/sh",
                "-c",
                "printf '%s\\t%s\\n' \"$(uname -s)\" \"$(uname -m)\"",
            ])
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| format!("timed out while probing WSL platform for '{distro}'"))?
    .map_err(|error| format!("failed to probe WSL platform for '{distro}': {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "failed to probe WSL platform for '{distro}': {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let target = parse_target_probe(&output.stdout, "WSL")?;
    if target.platform != ServerPlatform::Linux {
        return Err("WSL target did not report Linux".to_owned());
    }
    Ok(target)
}

async fn probe_ssh_target(target: &SshTarget) -> Result<ServerTarget, String> {
    let mut args = ssh_base_args(target)?;
    args.push(wrap_posix_script(
        "printf '%s\\t%s\\n' \"$(uname -s)\" \"$(uname -m)\"",
    ));
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        Command::new("ssh").args(args).stdin(Stdio::null()).output(),
    )
    .await
    .map_err(|_| "timed out while probing remote pilo-server platform".to_owned())?
    .map_err(|error| format!("failed to probe remote pilo-server platform: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "failed to probe remote pilo-server platform: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_target_probe(&output.stdout, "remote")
}

async fn deploy_wsl_server(
    distro: &str,
    source: &Path,
    remote_path: &str,
    fingerprint: &str,
    expected_size: u64,
) -> Result<(), String> {
    let source = normalize_windows_path_for_wsl(&source.to_string_lossy());
    let install_script = format!(
        "set -e; dst=\"$HOME/{remote_path}\"; expected=\"{fingerprint}\"; expected_size={expected_size}; file_size() {{ wc -c < \"$1\" 2>/dev/null | tr -d '[:space:]'; }}; if [ -x \"$dst\" ] && [ \"$(file_size \"$dst\")\" = \"$expected_size\" ]; then printf 'ready\\n'; exit 0; fi; src=$(wslpath -u \"$1\"); [ -f \"$src\" ] || {{ printf 'source_missing\\t%s\\n' \"$src\" >&2; exit 44; }}; [ \"$(file_size \"$src\")\" = \"$expected_size\" ] || {{ printf 'source_size_mismatch\\n' >&2; exit 45; }}; mkdir -p \"$(dirname \"$dst\")\"; tmp=\"$dst.tmp.$$\"; trap 'rm -f \"$tmp\"' EXIT; cp -- \"$src\" \"$tmp\"; [ \"$(file_size \"$tmp\")\" = \"$expected_size\" ] || {{ printf 'copy_size_mismatch\\n' >&2; exit 46; }}; chmod 700 \"$tmp\"; mv -f \"$tmp\" \"$dst\"; trap - EXIT; actual=$(\"$dst\" --fingerprint 2>/dev/null || true); [ \"$actual\" = \"$expected\" ] || {{ rm -f \"$dst\"; printf 'fingerprint_mismatch\\n' >&2; exit 43; }}; printf 'installed\\n'"
    );
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        Command::new("wsl.exe")
            .args([
                "--distribution",
                distro,
                "--exec",
                "/bin/sh",
                "-c",
                &install_script,
                "pilo-deploy",
                &source,
            ])
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| format!("timed out while deploying pilo-server to WSL '{distro}'"))?
    .map_err(|error| format!("failed to deploy pilo-server to WSL '{distro}': {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if output.status.success() && matches!(stdout.trim(), "ready" | "installed") {
        return Ok(());
    }
    if let Some(arch) = stdout
        .lines()
        .find_map(|line| line.strip_prefix("unsupported\t"))
    {
        return Err(format!(
            "WSL architecture '{arch}' is not supported by the bundled Linux pilo-server"
        ));
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "failed to deploy pilo-server to WSL '{distro}': {}",
        stderr.trim()
    ))
}

fn normalize_windows_path_for_wsl(value: &str) -> String {
    if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{value}");
    }
    value.strip_prefix(r"\\?\").unwrap_or(value).to_owned()
}

async fn server_artifact(target: ServerTarget) -> Result<Arc<ServerArtifact>, String> {
    let artifacts = SERVER_ARTIFACTS
        .get_or_init(|| async { Mutex::new(HashMap::new()) })
        .await;
    if let Some(artifact) = artifacts.lock().await.get(&target).cloned() {
        return Ok(artifact);
    }

    let path = server_binary(target)?;
    let probe_path = path.clone();
    let (fingerprint, size) = tokio::task::spawn_blocking(move || {
        let size = std::fs::metadata(&probe_path)
            .map_err(|error| {
                format!(
                    "failed to inspect pilo-server '{}': {error}",
                    probe_path.display()
                )
            })?
            .len();
        let fingerprint = pilo_server::binary_fingerprint(&probe_path).map_err(|error| {
            format!(
                "failed to fingerprint pilo-server '{}': {error}",
                probe_path.display()
            )
        })?;
        Ok::<_, String>((fingerprint, size))
    })
    .await
    .map_err(|error| format!("pilo-server artifact probe failed: {error}"))??;
    let artifact = Arc::new(ServerArtifact {
        path,
        fingerprint,
        size,
    });
    artifacts.lock().await.insert(target, Arc::clone(&artifact));
    Ok(artifact)
}

async fn deploy_server(connection: &Connection, target: ServerTarget) -> Result<String, String> {
    let artifact = server_artifact(target).await?;
    let source = &artifact.path;
    let fingerprint = &artifact.fingerprint;
    let remote_path = format!("{SERVER_REMOTE_DIR}/pilo-server-{fingerprint}");
    if let ConnectionKind::Wsl { distro } = &connection.kind {
        deploy_wsl_server(distro, source, &remote_path, fingerprint, artifact.size).await?;
        return Ok(remote_path);
    }
    let install_script = format!(
        "set -e; dst=\"$HOME/{remote_path}\"; expected=\"{fingerprint}\"; expected_size={}; file_size() {{ wc -c < \"$1\" 2>/dev/null | tr -d '[:space:]'; }}; if [ -x \"$dst\" ] && [ \"$(file_size \"$dst\")\" = \"$expected_size\" ]; then printf 'ready\\n'; exit 0; fi; rm -f \"$dst\"; mkdir -p \"$(dirname \"$dst\")\"; printf 'upload\\n'; tmp=\"$dst.tmp.$$\"; trap 'rm -f \"$tmp\"' EXIT; cat > \"$tmp\"; [ \"$(file_size \"$tmp\")\" = \"$expected_size\" ] || {{ printf 'upload_size_mismatch\\n'; exit 45; }}; chmod 700 \"$tmp\"; mv -f \"$tmp\" \"$dst\"; trap - EXIT; actual=$(\"$dst\" --fingerprint 2>/dev/null || true); [ \"$actual\" = \"$expected\" ] || {{ rm -f \"$dst\"; printf 'fingerprint_mismatch\\n'; exit 43; }}; printf 'installed\\n'",
        artifact.size,
    );
    let mut command = match &connection.kind {
        ConnectionKind::Wsl { .. } => unreachable!("WSL deployment is handled before upload"),
        ConnectionKind::Ssh { target } => {
            let mut args = ssh_base_args(target)?;
            args.push(wrap_posix_script(&install_script));
            let mut command = Command::new("ssh");
            command.args(args);
            command
        }
        ConnectionKind::Local => return Ok(String::new()),
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to deploy pilo-server: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "pilo-server deploy stdin unavailable".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "pilo-server deploy stdout unavailable".to_owned())?;
    let mut stdout = BufReader::new(stdout).lines();
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "pilo-server deploy stderr unavailable".to_owned())?;
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes).await;
        bytes
    });

    let status_line = tokio::time::timeout(std::time::Duration::from_secs(8), stdout.next_line())
        .await
        .map_err(|_| "timed out while preparing remote pilo-server".to_owned())?
        .map_err(|error| format!("failed to read pilo-server deploy status: {error}"))?
        .unwrap_or_default();
    if status_line == "ready" {
        drop(stdin);
        let status = child.wait().await.map_err(|error| error.to_string())?;
        let stderr = stderr_task.await.unwrap_or_default();
        if status.success() {
            return Ok(remote_path);
        }
        return Err(format!(
            "failed to reuse pilo-server: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    if let Some(arch) = status_line.strip_prefix("unsupported\t") {
        drop(stdin);
        let _ = child.wait().await;
        let _ = stderr_task.await;
        return Err(format!(
            "remote architecture '{arch}' is not supported by the bundled Linux pilo-server"
        ));
    }
    if status_line != "upload" {
        drop(stdin);
        let _ = child.wait().await;
        let stderr = stderr_task.await.unwrap_or_default();
        return Err(format!(
            "unexpected pilo-server deploy status '{status_line}': {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }

    let mut source_file = tokio::fs::File::open(source)
        .await
        .map_err(|error| format!("failed to open pilo-server '{}': {error}", source.display()))?;
    let uploaded = tokio::io::copy(&mut source_file, &mut stdin)
        .await
        .map_err(|error| format!("failed to upload pilo-server: {error}"))?;
    if uploaded != artifact.size {
        return Err(format!(
            "pilo-server upload was truncated: expected {} bytes, wrote {uploaded}",
            artifact.size
        ));
    }
    drop(stdin);
    let installed_line = stdout
        .next_line()
        .await
        .map_err(|error| format!("failed to read pilo-server install status: {error}"))?
        .unwrap_or_default();
    let status = child.wait().await.map_err(|error| error.to_string())?;
    let stderr = stderr_task.await.unwrap_or_default();
    if !status.success() || installed_line != "installed" {
        return Err(format!(
            "failed to deploy pilo-server ({installed_line}): {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    Ok(remote_path)
}

fn installed_server_candidates(exe: &Path, resource_name: &str) -> Vec<PathBuf> {
    let Some(dir) = exe.parent() else {
        return Vec::new();
    };

    let mut candidates = vec![
        dir.join("runtime").join(resource_name),
        dir.join("../Resources/runtime").join(resource_name),
    ];
    if let Some(exe_name) = exe.file_stem().and_then(|name| name.to_str()) {
        candidates.push(
            dir.join("../lib")
                .join(exe_name)
                .join("runtime")
                .join(resource_name),
        );
    }
    candidates
}

fn server_binary(target: ServerTarget) -> Result<PathBuf, String> {
    let resource_name = target.resource_name();
    if let Some(path) = std::env::var_os("PILO_SERVER_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Ok(path);
    }
    if target.platform == ServerPlatform::Linux
        && target.arch == ServerArch::X86_64
        && let Some(path) = std::env::var_os("PILO_SERVER_LINUX_PATH")
            .map(PathBuf::from)
            .filter(|path| path.is_file())
    {
        return Ok(path);
    }

    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        candidates.extend(installed_server_candidates(&exe, resource_name));
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("resources").join(resource_name));

    candidates.into_iter().find(|path| path.is_file()).ok_or_else(|| {
        format!(
            "bundled pilo-server runtime '{resource_name}' is missing; build or stage that target before packaging Pilo"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINUX_X86_64: ServerTarget = ServerTarget {
        platform: ServerPlatform::Linux,
        arch: ServerArch::X86_64,
    };
    const LINUX_AARCH64: ServerTarget = ServerTarget {
        platform: ServerPlatform::Linux,
        arch: ServerArch::Aarch64,
    };

    #[test]
    fn bundled_server_targets_have_stable_resource_names() {
        let cases = [
            (
                ServerTarget {
                    platform: ServerPlatform::Windows,
                    arch: ServerArch::X86_64,
                },
                "pilo-server-windows-x86_64.exe",
            ),
            (
                ServerTarget {
                    platform: ServerPlatform::Windows,
                    arch: ServerArch::Aarch64,
                },
                "pilo-server-windows-aarch64.exe",
            ),
            (LINUX_X86_64, "pilo-server-linux-x86_64"),
            (LINUX_AARCH64, "pilo-server-linux-aarch64"),
            (
                ServerTarget {
                    platform: ServerPlatform::Darwin,
                    arch: ServerArch::X86_64,
                },
                "pilo-server-darwin-x86_64",
            ),
            (
                ServerTarget {
                    platform: ServerPlatform::Darwin,
                    arch: ServerArch::Aarch64,
                },
                "pilo-server-darwin-aarch64",
            ),
        ];
        for (target, expected) in cases {
            assert_eq!(target.resource_name(), expected);
        }
    }

    #[test]
    fn platform_probe_maps_linux_and_macos_architectures() {
        assert_eq!(
            parse_target_probe(b"Linux\tx86_64\n", "test").unwrap(),
            LINUX_X86_64
        );
        assert_eq!(
            parse_target_probe(b"Linux\taarch64\n", "test").unwrap(),
            LINUX_AARCH64
        );
        assert_eq!(
            parse_target_probe(b"Darwin\tarm64\n", "test").unwrap(),
            ServerTarget {
                platform: ServerPlatform::Darwin,
                arch: ServerArch::Aarch64,
            }
        );
        assert!(parse_target_probe(b"FreeBSD\tx86_64\n", "test").is_err());
        assert!(parse_target_probe(b"Linux\triscv64\n", "test").is_err());
    }

    #[test]
    fn current_platform_resolves_its_staged_server_runtime() {
        let target = ServerTarget::current().unwrap();
        let path = server_binary(target).unwrap();
        assert!(path.is_file());
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some(target.resource_name())
        );
    }

    #[test]
    fn installed_runtime_candidates_cover_bundle_layouts() {
        let name = "pilo-server-linux-x86_64";
        assert_eq!(
            installed_server_candidates(Path::new("/install/Pilo.exe"), name)[0],
            Path::new("/install/runtime/pilo-server-linux-x86_64")
        );
        assert_eq!(
            installed_server_candidates(
                Path::new("/Applications/Pilo.app/Contents/MacOS/pilo"),
                name
            )[1],
            Path::new(
                "/Applications/Pilo.app/Contents/MacOS/../Resources/runtime/pilo-server-linux-x86_64"
            )
        );
        assert_eq!(
            installed_server_candidates(Path::new("/usr/bin/pilo"), name)[2],
            Path::new("/usr/bin/../lib/pilo/runtime/pilo-server-linux-x86_64")
        );
    }

    #[tokio::test]
    async fn disconnect_fails_pending_requests_and_notifies_subscribers() {
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let (reply_tx, reply_rx) = oneshot::channel();
        pending
            .lock()
            .await
            .insert(42, PendingRequest { reply: reply_tx });
        let events = ServerEventHub::default();
        let mut subscriber = events.subscribe("pi:test");
        let closed = AtomicBool::new(false);

        mark_disconnected(&pending, &events, &closed, "transport lost".to_owned()).await;

        assert!(closed.load(Ordering::Acquire));
        assert!(matches!(
            reply_rx.await.unwrap(),
            Err(error) if error == "transport lost"
        ));
        let event = subscriber.recv().await.unwrap();
        assert_eq!(event.event, SERVER_DISCONNECTED_EVENT);
        assert_eq!(event.stream_id, "");
        assert_eq!(event.data, json!({ "message": "transport lost" }));
    }

    #[tokio::test]
    async fn event_hub_routes_only_to_matching_stream() {
        let events = ServerEventHub::default();
        let mut first = events.subscribe("stream:first");
        let mut second = events.subscribe("stream:second");

        events.send(ServerEvent {
            stream_id: "stream:first".to_owned(),
            event: "terminal.output".to_owned(),
            data: Value::Null,
            binary: vec![vec![1, 2, 3]],
        });

        let event = first.recv().await.unwrap();
        assert_eq!(event.stream_id, "stream:first");
        assert_eq!(event.binary, vec![vec![1, 2, 3]]);
        assert!(matches!(
            second.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn reconnect_retry_is_limited_to_read_only_methods() {
        for method in [
            "server.status",
            "environment.inspect",
            "fs.read_file",
            "fs.search",
            "session.scan",
            "session.read",
            "preview.ports",
        ] {
            assert!(
                retryable_read_method(method),
                "{method} should be retryable"
            );
        }
        for method in [
            "command.run",
            "fs.write_file",
            "fs.rename",
            "fs.remove",
            "session.watch_start",
            "terminal.open",
            "pi.start",
            "pi.send",
        ] {
            assert!(
                !retryable_read_method(method),
                "{method} must not be replayed"
            );
        }
    }
}
