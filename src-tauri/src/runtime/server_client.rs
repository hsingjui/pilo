use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use pilo_protocol::{Envelope, PROTOCOL_VERSION, ServerHello, read_frame, write_frame};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex, broadcast, mpsc, oneshot},
    task::JoinHandle,
};

use crate::domain::{Connection, ConnectionKind};

use super::ssh::{ssh_base_args, wrap_posix_script};

const SERVER_REMOTE_DIR: &str = ".cache/pilo/server-v1";
const REQUEST_CAPACITY: usize = 256;
const HELLO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

type PendingReply = oneshot::Sender<Result<Value, String>>;
type PendingRequests = Arc<Mutex<HashMap<u64, PendingReply>>>;

#[derive(Clone, Debug)]
pub struct ServerEvent {
    pub stream_id: String,
    pub event: String,
    pub data: Value,
}

struct ServerProcess {
    child: Child,
    writer_task: JoinHandle<()>,
    reader_task: JoinHandle<()>,
}

pub struct ServerClient {
    request_id: AtomicU64,
    writer: mpsc::Sender<Envelope>,
    pending: PendingRequests,
    events: broadcast::Sender<ServerEvent>,
    process: Mutex<Option<ServerProcess>>,
    closed: Arc<AtomicBool>,
}

impl ServerClient {
    async fn connect(connection: &Connection) -> Result<Arc<Self>, String> {
        let mut child = spawn_server(connection).await?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "pilo-server stdin unavailable".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "pilo-server stdout unavailable".to_owned())?;
        let stderr = child.stderr.take();
        let (writer_tx, writer_rx) = mpsc::channel(REQUEST_CAPACITY);
        let (events, _) = broadcast::channel(512);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));

        let writer_task = tokio::spawn(writer_loop(stdin, writer_rx));
        let reader_task = tokio::spawn(reader_loop(
            stdout,
            Arc::clone(&pending),
            events.clone(),
            Arc::clone(&closed),
        ));
        if let Some(mut stderr) = stderr {
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
        }

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
        Ok(client)
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT)
            .await
    }

    async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: std::time::Duration,
    ) -> Result<Value, String> {
        let id = self.request_id.fetch_add(1, Ordering::Relaxed);
        let (reply_tx, reply_rx) = oneshot::channel();
        self.pending.lock().await.insert(id, reply_tx);
        if self
            .writer
            .send(Envelope::Request {
                id,
                method: method.to_owned(),
                params,
            })
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

    pub async fn request_typed<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
    ) -> Result<T, String> {
        serde_json::from_value(self.request(method, params).await?)
            .map_err(|error| format!("invalid pilo-server response for {method}: {error}"))
    }

    async fn request_typed_with_timeout<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
        timeout: std::time::Duration,
    ) -> Result<T, String> {
        serde_json::from_value(self.request_with_timeout(method, params, timeout).await?)
            .map_err(|error| format!("invalid pilo-server response for {method}: {error}"))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.events.subscribe()
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    async fn stop(&self) {
        self.closed.store(true, Ordering::Release);
        let Some(mut process) = self.process.lock().await.take() else {
            return;
        };
        process.writer_task.abort();
        process.reader_task.abort();
        let _ = process.child.kill().await;
        let _ = process.child.wait().await;
    }
}

async fn writer_loop(mut stdin: ChildStdin, mut requests: mpsc::Receiver<Envelope>) {
    while let Some(request) = requests.recv().await {
        if write_frame(&mut stdin, &request).await.is_err() {
            break;
        }
    }
}

async fn reader_loop(
    mut stdout: ChildStdout,
    pending: PendingRequests,
    events: broadcast::Sender<ServerEvent>,
    closed: Arc<AtomicBool>,
) {
    loop {
        match read_frame(&mut stdout).await {
            Ok(Some(Envelope::Response { id, result, error })) => {
                if let Some(reply) = pending.lock().await.remove(&id) {
                    let value = match error {
                        Some(error) => Err(error.message),
                        None => Ok(result.unwrap_or(Value::Null)),
                    };
                    let _ = reply.send(value);
                }
            }
            Ok(Some(Envelope::Event {
                stream_id,
                event,
                data,
            })) => {
                let _ = events.send(ServerEvent {
                    stream_id,
                    event,
                    data,
                });
            }
            Ok(Some(Envelope::Request { .. })) => {}
            Ok(None) | Err(_) => break,
        }
    }
    closed.store(true, Ordering::Release);
    let mut pending = pending.lock().await;
    for (_, reply) in pending.drain() {
        let _ = reply.send(Err("pilo-server disconnected".to_owned()));
    }
}

#[derive(Default)]
pub struct ServerManager {
    clients: Mutex<HashMap<String, Arc<ServerClient>>>,
}

impl ServerManager {
    pub async fn client(&self, connection: &Connection) -> Result<Arc<ServerClient>, String> {
        let mut clients = self.clients.lock().await;
        if let Some(client) = clients.get(&connection.id).cloned() {
            if !client.is_closed() {
                return Ok(client);
            }
            clients.remove(&connection.id);
        }
        let client = ServerClient::connect(connection).await?;
        clients.insert(connection.id.clone(), Arc::clone(&client));
        Ok(client)
    }

    pub async fn request(
        &self,
        connection: &Connection,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.client(connection).await?.request(method, params).await
    }

    pub async fn request_typed<T: DeserializeOwned>(
        &self,
        connection: &Connection,
        method: &str,
        params: Value,
    ) -> Result<T, String> {
        self.client(connection)
            .await?
            .request_typed(method, params)
            .await
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

async fn spawn_server(connection: &Connection) -> Result<Child, String> {
    let mut command = match &connection.kind {
        ConnectionKind::Local => {
            let executable = std::env::current_exe()
                .map_err(|error| format!("failed to locate Pilo executable: {error}"))?;
            let mut command = Command::new(executable);
            command.arg("--pilo-server");
            command
        }
        ConnectionKind::Wsl { distro } => {
            let remote_path = deploy_server(connection).await?;
            let mut command = Command::new("wsl.exe");
            command.args([
                "--distribution",
                distro,
                "--exec",
                "/bin/sh",
                "-c",
                &format!("exec \"$HOME/{remote_path}\""),
            ]);
            command
        }
        ConnectionKind::Ssh { target } => {
            let remote_path = deploy_server(connection).await?;
            let mut args = ssh_base_args(target)?;
            args.push(wrap_posix_script(&format!("exec \"$HOME/{remote_path}\"")));
            let mut command = Command::new("ssh");
            command.args(args);
            command
        }
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.spawn().map_err(|error| {
        format!(
            "failed to start pilo-server for '{}': {error}",
            connection.name
        )
    })
}

async fn deploy_wsl_server(
    distro: &str,
    source: &Path,
    remote_path: &str,
    fingerprint: &str,
) -> Result<(), String> {
    let source = normalize_windows_path_for_wsl(&source.to_string_lossy());
    let install_script = format!(
        "set -e; arch=$(uname -m); case \"$arch\" in x86_64|amd64) ;; *) printf 'unsupported\\t%s\\n' \"$arch\"; exit 42 ;; esac; dst=\"$HOME/{remote_path}\"; expected=\"{fingerprint}\"; if [ -x \"$dst\" ] && [ \"$(\"$dst\" --fingerprint 2>/dev/null || true)\" = \"$expected\" ]; then printf 'ready\\n'; exit 0; fi; src=$(wslpath -u \"$1\"); [ -f \"$src\" ] || {{ printf 'source_missing\\t%s\\n' \"$src\" >&2; exit 44; }}; mkdir -p \"$(dirname \"$dst\")\"; tmp=\"$dst.tmp.$$\"; trap 'rm -f \"$tmp\"' EXIT; cp -- \"$src\" \"$tmp\"; chmod 700 \"$tmp\"; mv -f \"$tmp\" \"$dst\"; trap - EXIT; actual=$(\"$dst\" --fingerprint); [ \"$actual\" = \"$expected\" ] || {{ rm -f \"$dst\"; printf 'fingerprint_mismatch\\n' >&2; exit 43; }}; printf 'installed\\n'"
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

async fn deploy_server(connection: &Connection) -> Result<String, String> {
    let source = linux_server_binary()?;
    let fingerprint = pilo_server::binary_fingerprint(&source).map_err(|error| {
        format!(
            "failed to fingerprint pilo-server '{}': {error}",
            source.display()
        )
    })?;
    let remote_path = format!("{SERVER_REMOTE_DIR}/pilo-server-{fingerprint}");
    if let ConnectionKind::Wsl { distro } = &connection.kind {
        deploy_wsl_server(distro, &source, &remote_path, &fingerprint).await?;
        return Ok(remote_path);
    }
    let data = std::fs::read(&source)
        .map_err(|error| format!("failed to read pilo-server '{}': {error}", source.display()))?;
    let install_script = format!(
        "set -e; arch=$(uname -m); case \"$arch\" in x86_64|amd64) ;; *) printf 'unsupported\\t%s\\n' \"$arch\"; exit 42 ;; esac; dst=\"$HOME/{remote_path}\"; expected=\"{fingerprint}\"; if [ -x \"$dst\" ] && [ \"$(\"$dst\" --fingerprint 2>/dev/null || true)\" = \"$expected\" ]; then printf 'ready\\n'; exit 0; fi; rm -f \"$dst\"; mkdir -p \"$(dirname \"$dst\")\"; printf 'upload\\n'; tmp=\"$dst.tmp.$$\"; trap 'rm -f \"$tmp\"' EXIT; cat > \"$tmp\"; chmod 700 \"$tmp\"; mv -f \"$tmp\" \"$dst\"; trap - EXIT; actual=$(\"$dst\" --fingerprint); [ \"$actual\" = \"$expected\" ] || {{ rm -f \"$dst\"; printf 'fingerprint_mismatch\\n'; exit 43; }}; printf 'installed\\n'"
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

    stdin
        .write_all(&data)
        .await
        .map_err(|error| error.to_string())?;
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

fn linux_server_binary() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("PILO_SERVER_LINUX_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Ok(path);
    }
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        candidates.extend([
            dir.join("pilo-server-linux-x86_64"),
            dir.join("resources/pilo-server-linux-x86_64"),
            dir.join("pilo-server"),
        ]);
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    candidates.extend([
        manifest.join("../target/debug/pilo-server"),
        manifest.join("../target/release/pilo-server"),
        manifest.join("resources/pilo-server-linux-x86_64"),
    ]);
    candidates.into_iter().find(|path| path.is_file()).ok_or_else(|| "Linux pilo-server binary is missing; build it with `cargo build -p pilo-server` and set PILO_SERVER_LINUX_PATH when running the Windows app".to_owned())
}
