use std::{
    collections::HashMap,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Instant, UNIX_EPOCH},
};

use notify::{Event, EventKind, RecursiveMode, Watcher};
use pilo_protocol::{
    Envelope, EnvironmentInfo, FsEntry, FsEntryKind, MAX_BINARY_PAYLOAD_BYTES, PROTOCOL_VERSION,
    SERVER_CAPABILITIES, ServerHello, ServerStatus, SessionFile, read_frame, write_frame,
};
use portable_pty::{Child as PtyChild, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, OnceCell, Semaphore, mpsc},
    task::JoinHandle,
};

pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_IN_FLIGHT_REQUESTS: usize = 64;
const SESSION_WATCH_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(150);

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

struct PiProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn PtyChild + Send + Sync>,
}

struct ToolchainInfo {
    path: String,
    home: String,
    shell: String,
    pi_executable: String,
    pi_version: String,
    node_executable: String,
    node_version: String,
    git_executable: String,
    git_version: String,
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
            if write_frame(&mut stdout, &message).await.is_err() {
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

#[derive(Deserialize)]
struct WorkspaceParams {
    workspace: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandParams {
    workspace: String,
    program: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default = "default_command_timeout_ms")]
    timeout_ms: u64,
}

const fn default_command_timeout_ms() -> u64 {
    60_000
}

async fn read_bounded_output<R>(
    mut reader: R,
    used: Arc<AtomicUsize>,
    overflowed: Arc<AtomicBool>,
    limit: usize,
) -> Result<Vec<u8>, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(output);
        }
        let previous = used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                Some(value.saturating_add(read))
            })
            .unwrap_or_else(|value| value);
        if previous < limit {
            let keep = read.min(limit - previous);
            output.extend_from_slice(&buffer[..keep]);
            if keep < read {
                overflowed.store(true, Ordering::Release);
            }
        } else {
            overflowed.store(true, Ordering::Release);
        }
    }
}

async fn command_run(
    state: &ServerState,
    params: CommandParams,
    input: Vec<u8>,
) -> Result<ServerReply, String> {
    if input.len() > MAX_BINARY_PAYLOAD_BYTES {
        return Err(format!(
            "command input is {} bytes; pilo-server limit is {} bytes",
            input.len(),
            MAX_BINARY_PAYLOAD_BYTES
        ));
    }
    let path = cached_login_path(state).await;
    let program = resolve_program(&path, &params.program);
    let mut command = process_command(&program, &params.args, &path);
    command
        .current_dir(&params.workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to run '{program}': {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "command stdin unavailable".to_owned())?;
    let stdin_write = async move {
        if !input.is_empty() {
            stdin
                .write_all(&input)
                .await
                .map_err(|error| error.to_string())?;
        }
        drop(stdin);
        Ok::<(), String>(())
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "command stdout unavailable".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "command stderr unavailable".to_owned())?;
    let used = Arc::new(AtomicUsize::new(0));
    let overflowed = Arc::new(AtomicBool::new(false));
    let stdout_read = read_bounded_output(
        stdout,
        Arc::clone(&used),
        Arc::clone(&overflowed),
        MAX_BINARY_PAYLOAD_BYTES,
    );
    let stderr_read = read_bounded_output(
        stderr,
        Arc::clone(&used),
        Arc::clone(&overflowed),
        MAX_BINARY_PAYLOAD_BYTES,
    );
    let timeout_ms = params.timeout_ms.clamp(1, 10 * 60 * 1000);
    let result = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), async {
        tokio::join!(stdin_write, stdout_read, stderr_read, child.wait())
    })
    .await;
    let (stdout, stderr, status) = match result {
        Ok((stdin, stdout, stderr, status)) => {
            stdin.map_err(|error| format!("failed to write command stdin: {error}"))?;
            (
                stdout.map_err(|error| format!("failed to read command stdout: {error}"))?,
                stderr.map_err(|error| format!("failed to read command stderr: {error}"))?,
                status.map_err(|error| error.to_string())?,
            )
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(format!(
                "command '{}' timed out after {timeout_ms} ms",
                params.program
            ));
        }
    };
    if overflowed.load(Ordering::Acquire) {
        return Err(format!(
            "command '{}' produced more than {} bytes; output was discarded after the limit",
            params.program, MAX_BINARY_PAYLOAD_BYTES
        ));
    }
    Ok(ServerReply::with_binary(
        json!({ "code": status.code() }),
        vec![stdout, stderr],
    ))
}

async fn environment_inspect(
    state: &ServerState,
    params: WorkspaceParams,
) -> Result<Value, String> {
    let probe_workspace = params.workspace;
    let cwd = tokio::task::spawn_blocking(move || {
        let cwd = std::fs::canonicalize(&probe_workspace)
            .map_err(|error| format!("workspace '{probe_workspace}' is not accessible: {error}"))?;
        if !cwd.is_dir() {
            return Err(format!("workspace '{probe_workspace}' is not a directory"));
        }
        Ok::<_, String>(cwd)
    })
    .await
    .map_err(|error| format!("workspace probe task failed: {error}"))??;
    let toolchain = cached_toolchain(state).await?;
    let git_branch = if toolchain.git_executable.is_empty() {
        None
    } else {
        let value = command_text(
            &toolchain.git_executable,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            Some(&cwd),
            &toolchain.path,
        )
        .await
        .unwrap_or_default();
        (!value.is_empty()).then_some(value)
    };
    to_value(EnvironmentInfo {
        cwd: cwd.to_string_lossy().into_owned(),
        path: toolchain.path.clone(),
        home: toolchain.home.clone(),
        shell: toolchain.shell.clone(),
        pi_executable: toolchain.pi_executable.clone(),
        pi_version: toolchain.pi_version.clone(),
        node_executable: toolchain.node_executable.clone(),
        node_version: toolchain.node_version.clone(),
        git_executable: toolchain.git_executable.clone(),
        git_version: toolchain.git_version.clone(),
        git_branch,
    })
}

fn default_shell() -> String {
    if cfg!(windows) {
        return std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_owned());
    }
    if let Ok(shell) = std::env::var("SHELL")
        && Path::new(&shell).is_file()
    {
        return shell;
    }
    if let (Ok(home), Ok(passwd)) = (
        std::env::var("HOME"),
        std::fs::read_to_string("/etc/passwd"),
    ) {
        for line in passwd.lines() {
            let fields = line.split(':').collect::<Vec<_>>();
            if fields.len() >= 7 && fields[5] == home && Path::new(fields[6]).is_file() {
                return fields[6].to_owned();
            }
        }
    }
    "/bin/sh".to_owned()
}

async fn login_path(shell: &str) -> Option<String> {
    if cfg!(windows) {
        return std::env::var("PATH").ok();
    }
    const MARKER: &str = "__PILO_LOGIN_PATH__";
    let mut command = Command::new(shell);
    command
        .args(["-ilc", &format!("printf '{MARKER}%s' \"$PATH\"")])
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .rfind(MARKER)
        .map(|index| stdout[index + MARKER.len()..].trim().to_owned())
        .filter(|value| !value.is_empty())
}

async fn cached_login_path(state: &ServerState) -> String {
    state
        .login_path
        .get_or_init(|| async {
            let shell = default_shell();
            login_path(&shell)
                .await
                .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
        })
        .await
        .clone()
}

async fn cached_toolchain(state: &ServerState) -> Result<&ToolchainInfo, String> {
    state
        .toolchain
        .get_or_try_init(|| async {
            let shell = default_shell();
            let path = cached_login_path(state).await;
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_default();
            let pi_executable = find_command(&path, "pi")
                .ok_or_else(|| "Pi executable 'pi' was not found in PATH".to_owned())?;
            let node_executable = find_command(&path, "node").unwrap_or_default();
            let git_executable = find_command(&path, "git").unwrap_or_default();

            let pi_version_probe = command_text(&pi_executable, &["--version"], None, &path);
            let node_version_probe = async {
                if node_executable.is_empty() {
                    String::new()
                } else {
                    command_text(&node_executable, &["--version"], None, &path)
                        .await
                        .unwrap_or_default()
                }
            };
            let git_version_probe = async {
                if git_executable.is_empty() {
                    String::new()
                } else {
                    command_text(&git_executable, &["--version"], None, &path)
                        .await
                        .unwrap_or_default()
                }
            };
            let (pi_version, node_version, git_version) =
                tokio::join!(pi_version_probe, node_version_probe, git_version_probe);

            Ok(ToolchainInfo {
                path,
                home,
                shell,
                pi_executable,
                pi_version: pi_version?,
                node_executable,
                node_version,
                git_executable,
                git_version,
            })
        })
        .await
}

fn find_command(path: &str, name: &str) -> Option<String> {
    let extensions = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned())
            .split(';')
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    std::env::split_paths(path).find_map(|dir| {
        if cfg!(windows)
            && let Some(candidate) = extensions.iter().find_map(|extension| {
                let candidate = dir.join(format!("{name}{extension}"));
                candidate.is_file().then_some(candidate)
            })
        {
            return Some(candidate.to_string_lossy().into_owned());
        }
        let candidate = dir.join(name);
        candidate
            .is_file()
            .then(|| candidate.to_string_lossy().into_owned())
    })
}

fn resolve_program(path: &str, program: &str) -> String {
    let candidate = Path::new(program);
    if candidate.is_absolute() || program.contains('/') || program.contains('\\') {
        return program.to_owned();
    }
    find_command(path, program).unwrap_or_else(|| program.to_owned())
}

fn process_command(program: &str, args: &[String], path: &str) -> Command {
    let mut command = Command::new(program);
    command.args(args).env("PATH", path);
    command
}

#[cfg(windows)]
async fn command_text(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    path: &str,
) -> Result<String, String> {
    let program = program.to_owned();
    let args = args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let cwd = cwd.map(Path::to_path_buf);
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut command = std::process::Command::new(&program);
        command
            .args(&args)
            .env("PATH", path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to run '{program}': {error}"))?;
        let started = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < std::time::Duration::from_secs(8) => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "timed out while running '{program} {}'",
                        args.join(" ")
                    ));
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("failed to wait for '{program}': {error}"));
                }
            }
        }
        let output = child
            .wait_with_output()
            .map_err(|error| format!("failed to collect '{program}' output: {error}"))?;
        command_output_text(&output.stdout, &output.stderr, output.status.success())
    })
    .await
    .map_err(|error| format!("tool probe task failed: {error}"))?
}

#[cfg(not(windows))]
async fn command_text(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    path: &str,
) -> Result<String, String> {
    let args = args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let mut command = process_command(program, &args, path);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(8), command.output())
        .await
        .map_err(|_| format!("timed out while running '{program} {}'", args.join(" ")))?
        .map_err(|error| format!("failed to run '{program}': {error}"))?;
    command_output_text(&output.stdout, &output.stderr, output.status.success())
}

fn command_output_text(stdout: &[u8], stderr: &[u8], success: bool) -> Result<String, String> {
    if !success {
        return Err(String::from_utf8_lossy(stderr).trim().to_owned());
    }
    let text = if stdout.is_empty() { stderr } else { stdout };
    Ok(String::from_utf8_lossy(text).trim().to_owned())
}

#[derive(Deserialize)]
struct FsPathParams {
    workspace: String,
    path: String,
}
#[derive(Deserialize)]
struct FsWriteParams {
    workspace: String,
    path: String,
}
#[derive(Deserialize)]
struct FsRenameParams {
    workspace: String,
    from: String,
    to: String,
}
#[derive(Deserialize)]
struct FsSearchParams {
    workspace: String,
    query: String,
}

#[derive(Deserialize)]
struct AbsolutePathParams {
    path: String,
}

fn canonical_workspace(workspace: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(workspace)
        .map_err(|error| format!("workspace '{workspace}' is not accessible: {error}"))?;
    if !root.is_dir() {
        return Err(format!("workspace '{workspace}' is not a directory"));
    }
    Ok(root)
}

fn relative_workspace_path(relative: &str, allow_root: bool) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative.components().any(|component| {
            !matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
    {
        return Err("path must stay inside the workspace".to_owned());
    }
    if relative.as_os_str().is_empty() && !allow_root {
        return Err("workspace root is not valid for this operation".to_owned());
    }
    Ok(relative.to_path_buf())
}

fn ensure_inside_workspace(root: &Path, path: &Path) -> Result<(), String> {
    if path == root || path.starts_with(root) {
        Ok(())
    } else {
        Err("path resolves outside the workspace".to_owned())
    }
}

fn checked_existing_path(
    workspace: &str,
    relative: &str,
    allow_root: bool,
) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_workspace(workspace)?;
    let relative = relative_workspace_path(relative, allow_root)?;
    let path = root
        .join(&relative)
        .canonicalize()
        .map_err(|error| format!("path '{}' is not accessible: {error}", relative.display()))?;
    ensure_inside_workspace(&root, &path)?;
    Ok((root, path))
}

fn checked_entry_path(
    workspace: &str,
    relative: &str,
    allow_root: bool,
) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_workspace(workspace)?;
    let relative = relative_workspace_path(relative, allow_root)?;
    let candidate = root.join(relative);
    if candidate == root {
        return Ok((root.clone(), root));
    }
    let parent = candidate
        .parent()
        .ok_or_else(|| "path has no parent directory".to_owned())?
        .canonicalize()
        .map_err(|error| format!("path parent is not accessible: {error}"))?;
    ensure_inside_workspace(&root, &parent)?;
    let name = candidate
        .file_name()
        .ok_or_else(|| "path has no file name".to_owned())?;
    Ok((root, parent.join(name)))
}

fn checked_mutation_path(workspace: &str, relative: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_workspace(workspace)?;
    let relative = relative_workspace_path(relative, false)?;
    let candidate = root.join(relative);
    if std::fs::symlink_metadata(&candidate).is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("mutating a symlink path is not allowed".to_owned());
    }

    let ancestor = candidate
        .ancestors()
        .find(|path| path.exists())
        .ok_or_else(|| "path has no accessible parent directory".to_owned())?;
    let canonical_ancestor = ancestor
        .canonicalize()
        .map_err(|error| format!("path parent is not accessible: {error}"))?;
    ensure_inside_workspace(&root, &canonical_ancestor)?;
    let suffix = candidate
        .strip_prefix(ancestor)
        .map_err(|error| error.to_string())?;
    Ok((root, canonical_ancestor.join(suffix)))
}

fn fs_entry(workspace: &Path, path: &Path) -> Result<FsEntry, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    let file_type = metadata.file_type();
    let kind = if file_type.is_symlink() {
        FsEntryKind::Symlink
    } else if file_type.is_dir() {
        FsEntryKind::Directory
    } else if file_type.is_file() {
        FsEntryKind::File
    } else {
        FsEntryKind::Other
    };
    let relative = path
        .strip_prefix(workspace)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_owned();
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            workspace
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let modified_at_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64);
    Ok(FsEntry {
        path: relative,
        name,
        kind,
        size: metadata.len(),
        modified_at_ms,
    })
}

fn fs_read_dir(params: FsPathParams) -> Result<Value, String> {
    let (workspace_root, root) = checked_existing_path(&params.workspace, &params.path, true)?;
    let mut entries = std::fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .map(|entry| {
            let entry = entry.map_err(|error| error.to_string())?;
            fs_entry(&workspace_root, &entry.path())
        })
        .collect::<Result<Vec<_>, String>>()?;
    entries.sort_by(|a, b| {
        (
            (a.kind != FsEntryKind::Directory) as u8,
            a.name.to_lowercase(),
        )
            .cmp(&(
                (b.kind != FsEntryKind::Directory) as u8,
                b.name.to_lowercase(),
            ))
    });
    to_value(entries)
}

fn fs_read_file(params: FsPathParams) -> Result<Vec<u8>, String> {
    let (_, path) = checked_existing_path(&params.workspace, &params.path, false)?;
    let size = std::fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_BINARY_PAYLOAD_BYTES as u64 {
        return Err(format!(
            "file '{}' is {size} bytes; pilo-server read limit is {} bytes",
            params.path, MAX_BINARY_PAYLOAD_BYTES
        ));
    }
    std::fs::read(path).map_err(|error| error.to_string())
}
fn fs_write_file(params: FsWriteParams, data: Vec<u8>) -> Result<Value, String> {
    if data.len() > MAX_BINARY_PAYLOAD_BYTES {
        return Err(format!(
            "file write is {} bytes; pilo-server limit is {} bytes",
            data.len(),
            MAX_BINARY_PAYLOAD_BYTES
        ));
    }
    let (_, path) = checked_mutation_path(&params.workspace, &params.path)?;
    std::fs::write(path, data).map_err(|error| error.to_string())?;
    Ok(Value::Null)
}
fn fs_stat(params: FsPathParams) -> Result<Value, String> {
    let (workspace_root, path) = checked_entry_path(&params.workspace, &params.path, true)?;
    to_value(fs_entry(&workspace_root, &path)?)
}
fn fs_mkdir(params: FsPathParams) -> Result<Value, String> {
    let (_, path) = checked_mutation_path(&params.workspace, &params.path)?;
    std::fs::create_dir_all(path).map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

fn fs_mkdir_absolute(params: AbsolutePathParams) -> Result<Value, String> {
    let path = PathBuf::from(&params.path);
    if !path.is_absolute() {
        return Err("absolute path is required".to_owned());
    }
    std::fs::create_dir_all(path).map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

fn fs_rename(params: FsRenameParams) -> Result<Value, String> {
    let (_, from) = checked_entry_path(&params.workspace, &params.from, false)?;
    let (_, to) = checked_mutation_path(&params.workspace, &params.to)?;
    std::fs::rename(from, to).map_err(|error| error.to_string())?;
    Ok(Value::Null)
}
fn fs_remove(params: FsPathParams) -> Result<Value, String> {
    let (_, path) = checked_entry_path(&params.workspace, &params.path, false)?;
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
    .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

fn fs_search(params: FsSearchParams) -> Result<Value, String> {
    fn visit(
        root: &Path,
        current: &Path,
        query: &str,
        result: &mut Vec<String>,
    ) -> Result<(), String> {
        if result.len() >= 200 {
            return Ok(());
        }
        for entry in std::fs::read_dir(current).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist") {
                    continue;
                }
                visit(root, &path, query, result)?;
            } else if file_type.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                if relative.to_lowercase().contains(query) {
                    result.push(relative);
                }
            }
        }
        Ok(())
    }
    let root = canonical_workspace(&params.workspace)?;
    let mut result = Vec::new();
    visit(
        &root,
        &root,
        &params.query.trim().to_lowercase(),
        &mut result,
    )?;
    to_value(result)
}

fn session_dir_key(workspace: &str) -> String {
    let normalized = workspace.trim().trim_start_matches(['/', '\\']);
    format!("--{}--", normalized.replace(['/', '\\', ':'], "-"))
}

fn agent_dir() -> Option<PathBuf> {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".pi/agent")))
        .or_else(|| {
            std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".pi/agent"))
        })
}

fn session_scan(params: WorkspaceParams) -> Result<Value, String> {
    let Some(root) = agent_dir().map(|root| {
        root.join("sessions")
            .join(session_dir_key(&params.workspace))
    }) else {
        return to_value(Vec::<SessionFile>::new());
    };
    let Ok(entries) = std::fs::read_dir(root) else {
        return to_value(Vec::<SessionFile>::new());
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let metadata = match std::fs::metadata(&path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let file = match std::fs::File::open(&path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let mut reader = std::io::BufReader::new(file);
        let mut line = String::new();
        use std::io::BufRead as _;
        if reader.read_line(&mut line).is_err() {
            continue;
        }
        let Ok(header) = serde_json::from_str(line.trim()) else {
            continue;
        };
        let mtime_ns = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos() as u64)
            .unwrap_or(0);
        files.push(SessionFile {
            path: path.to_string_lossy().into_owned(),
            size: metadata.len(),
            mtime_ns,
            header,
        });
    }
    to_value(files)
}

#[derive(Deserialize)]
struct SessionReadParams {
    path: String,
    #[serde(default)]
    offset: u64,
    #[serde(default = "default_session_read_limit")]
    limit: usize,
}

const fn default_session_read_limit() -> usize {
    8 * 1024 * 1024
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionWatchParams {
    stream_id: String,
    workspace: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionWatchStopParams {
    stream_id: String,
}
fn checked_session_file(path: &str) -> Result<PathBuf, String> {
    let requested = PathBuf::from(path);
    if requested.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return Err("session path must point to a JSONL file".to_owned());
    }
    let sessions_root = agent_dir()
        .map(|root| root.join("sessions"))
        .ok_or_else(|| "Pi agent directory is unavailable".to_owned())?
        .canonicalize()
        .map_err(|error| format!("Pi session directory is not accessible: {error}"))?;
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("session file '{path}' is not accessible: {error}"))?;
    if !canonical.starts_with(&sessions_root) {
        return Err("session path must stay inside the Pi session directory".to_owned());
    }
    Ok(canonical)
}

fn session_read(params: SessionReadParams) -> Result<(Value, Vec<u8>), String> {
    let path = checked_session_file(&params.path)?;
    let mut file = std::fs::File::open(&path)
        .map_err(|error| format!("failed to open session '{}': {error}", path.display()))?;
    let file_size = file.metadata().map_err(|error| error.to_string())?.len();
    use std::io::{Read as _, Seek as _, SeekFrom};
    file.seek(SeekFrom::Start(params.offset))
        .map_err(|error| error.to_string())?;
    let limit = params.limit.clamp(1, MAX_BINARY_PAYLOAD_BYTES);
    let mut data = Vec::with_capacity(limit.min(1024 * 1024));
    file.take(limit as u64)
        .read_to_end(&mut data)
        .map_err(|error| error.to_string())?;
    let next_offset = params.offset.saturating_add(data.len() as u64);
    Ok((
        json!({
            "nextOffset": next_offset,
            "eof": next_offset >= file_size,
        }),
        data,
    ))
}

fn session_discover() -> Result<Value, String> {
    let Some(root) = agent_dir().map(|root| root.join("sessions")) else {
        return to_value(Vec::<Value>::new());
    };
    let mut headers = Vec::new();
    let Ok(workspaces) = std::fs::read_dir(root) else {
        return to_value(headers);
    };
    'outer: for workspace in workspaces.flatten() {
        let Ok(files) = std::fs::read_dir(workspace.path()) else {
            continue;
        };
        for entry in files.flatten() {
            if headers.len() >= 500 {
                break 'outer;
            }
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(file) = std::fs::File::open(path) else {
                continue;
            };
            let mut reader = std::io::BufReader::new(file);
            let mut line = String::new();
            use std::io::BufRead as _;
            if reader.read_line(&mut line).is_ok()
                && let Ok(value) = serde_json::from_str::<Value>(line.trim())
            {
                headers.push(value);
            }
        }
    }
    to_value(headers)
}

fn session_watch_paths(workspace: &str) -> Result<(PathBuf, PathBuf), String> {
    let agent = agent_dir().ok_or_else(|| "Pi agent directory is unavailable".to_owned())?;
    let sessions = agent.join("sessions");
    let target = sessions.join(session_dir_key(workspace));
    let watch_root = if sessions.is_dir() {
        sessions
    } else if agent.is_dir() {
        agent
    } else {
        return Err(format!(
            "Pi agent directory '{}' is not accessible",
            agent.display()
        ));
    };
    Ok((target, watch_root))
}

fn is_session_change(event: &Event, target: &Path) -> bool {
    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    ) {
        return false;
    }
    event.paths.iter().any(|path| {
        path == target
            || (path.starts_with(target)
                && path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
    })
}

async fn session_watch_start(
    state: &ServerState,
    params: SessionWatchParams,
) -> Result<Value, String> {
    if let Some(task) = state
        .session_watchers
        .lock()
        .await
        .remove(&params.stream_id)
    {
        task.abort();
    }

    let (target, watch_root) = session_watch_paths(&params.workspace)?;
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = event_tx.send(event);
    })
    .map_err(|error| format!("failed to create session watcher: {error}"))?;
    watcher
        .watch(&watch_root, RecursiveMode::Recursive)
        .map_err(|error| {
            format!(
                "failed to watch Pi session directory '{}': {error}",
                watch_root.display()
            )
        })?;

    let stream_id = params.stream_id.clone();
    let writer = state.writer.clone();
    let task = tokio::spawn(async move {
        let _watcher = watcher;
        if writer
            .send(Envelope::event(
                stream_id.clone(),
                "session.backend",
                json!({
                    "backend": "server-native",
                    "root": watch_root.to_string_lossy(),
                }),
            ))
            .await
            .is_err()
        {
            return;
        }

        'events: while let Some(event) = event_rx.recv().await {
            match event {
                Ok(event) if is_session_change(&event, &target) => {
                    tokio::time::sleep(SESSION_WATCH_DEBOUNCE).await;
                    let mut errors = Vec::new();
                    while let Ok(event) = event_rx.try_recv() {
                        if let Err(error) = event {
                            errors.push(error.to_string());
                        }
                    }
                    for message in errors {
                        if writer
                            .send(Envelope::event(
                                stream_id.clone(),
                                "session.error",
                                json!({ "message": message }),
                            ))
                            .await
                            .is_err()
                        {
                            break 'events;
                        }
                    }
                    if writer
                        .send(Envelope::event(
                            stream_id.clone(),
                            "session.changed",
                            Value::Null,
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    if writer
                        .send(Envelope::event(
                            stream_id.clone(),
                            "session.error",
                            json!({ "message": error.to_string() }),
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
    state
        .session_watchers
        .lock()
        .await
        .insert(params.stream_id, task);
    Ok(Value::Null)
}

async fn session_watch_stop(
    state: &ServerState,
    params: SessionWatchStopParams,
) -> Result<Value, String> {
    if let Some(task) = state
        .session_watchers
        .lock()
        .await
        .remove(&params.stream_id)
    {
        task.abort();
    }
    Ok(Value::Null)
}

async fn preview_ports() -> Result<Value, String> {
    if cfg!(windows) {
        let script = "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique";
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .kill_on_drop(true);
        let output = tokio::time::timeout(std::time::Duration::from_secs(3), command.output())
            .await
            .map_err(|_| "timed out while listing preview ports".to_owned())?
            .map_err(|error| error.to_string())?;
        let ports = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u16>().ok())
            .collect::<Vec<_>>();
        return to_value(ports);
    }
    let script = "if command -v ss >/dev/null 2>&1; then ss -ltnH | awk '{a=$4; sub(/^.*:/,\"\",a); if(a ~ /^[0-9]+$/) print a}' | sort -nu; elif command -v netstat >/dev/null 2>&1; then netstat -lnt 2>/dev/null | awk 'NR>2 {a=$4; sub(/^.*:/,\"\",a); if(a ~ /^[0-9]+$/) print a}' | sort -nu; fi";
    let mut command = Command::new("/bin/sh");
    command.args(["-c", script]).kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(3), command.output())
        .await
        .map_err(|_| "timed out while listing preview ports".to_owned())?
        .map_err(|error| error.to_string())?;
    let ports = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u16>().ok())
        .collect::<Vec<_>>();
    to_value(ports)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOpenParams {
    stream_id: String,
    workspace: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalWriteParams {
    stream_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalResizeParams {
    stream_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalCloseParams {
    stream_id: String,
}

async fn terminal_open(state: &ServerState, params: TerminalOpenParams) -> Result<Value, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: params.rows.max(1),
            cols: params.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to open terminal PTY: {error}"))?;

    let shell = default_shell();
    let mut command = CommandBuilder::new(shell);
    command.cwd(&params.workspace);
    command.env("PATH", cached_login_path(state).await);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("failed to start terminal: {error}"))?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("failed to open terminal reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("failed to open terminal writer: {error}"))?;

    let stream_id = params.stream_id;
    {
        let mut terminals = state
            .terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_owned())?;
        if let Some(mut previous) = terminals.remove(&stream_id) {
            let _ = previous.child.kill();
            let _ = previous.child.wait();
        }
        terminals.insert(
            stream_id.clone(),
            TerminalSession {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    let event_stream_id = stream_id.clone();
    let event_writer = state.writer.clone();
    let terminals = Arc::clone(&state.terminals);
    if let Err(error) = std::thread::Builder::new()
        .name(format!("pilo-{stream_id}-reader"))
        .spawn(move || {
            let mut buffer = [0_u8; 16 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let _ = event_writer.blocking_send(Envelope::event(
                            event_stream_id.clone(),
                            "terminal.exit",
                            Value::Null,
                        ));
                        break;
                    }
                    Ok(read) => {
                        if event_writer
                            .blocking_send(Envelope::event_with_binary(
                                event_stream_id.clone(),
                                "terminal.output",
                                Value::Null,
                                vec![buffer[..read].to_vec()],
                            ))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = event_writer.blocking_send(Envelope::event(
                            event_stream_id.clone(),
                            "terminal.error",
                            json!({ "message": error.to_string() }),
                        ));
                        break;
                    }
                }
            }
            if let Ok(mut terminals) = terminals.lock()
                && let Some(mut terminal) = terminals.remove(&event_stream_id)
            {
                let _ = terminal.child.kill();
                let _ = terminal.child.wait();
            }
        })
    {
        if let Ok(mut terminals) = state.terminals.lock()
            && let Some(mut terminal) = terminals.remove(&stream_id)
        {
            let _ = terminal.child.kill();
            let _ = terminal.child.wait();
        }
        return Err(format!("failed to start terminal reader: {error}"));
    }
    Ok(Value::Null)
}

async fn terminal_write(
    state: &ServerState,
    params: TerminalWriteParams,
    data: Vec<u8>,
) -> Result<Value, String> {
    let terminals = Arc::clone(&state.terminals);
    blocking(move || {
        let mut terminals = terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_owned())?;
        let terminal = terminals
            .get_mut(&params.stream_id)
            .ok_or_else(|| format!("terminal '{}' is not running", params.stream_id))?;
        terminal
            .writer
            .write_all(&data)
            .and_then(|_| terminal.writer.flush())
            .map_err(|error| format!("failed to write terminal '{}': {error}", params.stream_id))?;
        Ok(Value::Null)
    })
    .await
}

async fn terminal_resize(
    state: &ServerState,
    params: TerminalResizeParams,
) -> Result<Value, String> {
    let terminals = Arc::clone(&state.terminals);
    blocking(move || {
        let terminals = terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_owned())?;
        let terminal = terminals
            .get(&params.stream_id)
            .ok_or_else(|| format!("terminal '{}' is not running", params.stream_id))?;
        terminal
            .master
            .resize(PtySize {
                rows: params.rows.max(1),
                cols: params.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| {
                format!("failed to resize terminal '{}': {error}", params.stream_id)
            })?;
        Ok(Value::Null)
    })
    .await
}

async fn terminal_close(state: &ServerState, params: TerminalCloseParams) -> Result<Value, String> {
    let terminals = Arc::clone(&state.terminals);
    blocking(move || {
        let Some(mut terminal) = terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_owned())?
            .remove(&params.stream_id)
        else {
            return Ok(Value::Null);
        };
        terminal
            .child
            .kill()
            .map_err(|error| format!("failed to stop terminal '{}': {error}", params.stream_id))?;
        let _ = terminal.child.wait();
        Ok(Value::Null)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiStartParams {
    stream_id: String,
    workspace: String,
    #[serde(default)]
    session_path: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiSendParams {
    stream_id: String,
    command: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiStopParams {
    stream_id: String,
}

async fn pi_start(state: &ServerState, params: PiStartParams) -> Result<Value, String> {
    let toolchain = cached_toolchain(state).await?;
    let path = toolchain.path.clone();
    let pi_executable = toolchain.pi_executable.clone();
    let mut processes = state.pi.lock().await;
    if processes.contains_key(&params.stream_id) {
        return Ok(json!({ "alreadyRunning": true }));
    }
    let mut args = vec!["--mode".to_owned(), "rpc".to_owned()];
    if let Some(path) = params.session_path.as_ref() {
        args.extend(["--session".to_owned(), path.clone()]);
    }
    let mut command = process_command(&pi_executable, &args, &path);
    command
        .current_dir(&params.workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start Pi RPC: {error}"))?;
    let stdin = Arc::new(Mutex::new(
        child
            .stdin
            .take()
            .ok_or_else(|| "Pi stdin unavailable".to_owned())?,
    ));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Pi stdout unavailable".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Pi stderr unavailable".to_owned())?;
    processes.insert(params.stream_id.clone(), PiProcess { child, stdin });
    drop(processes);

    let stream_id = params.stream_id.clone();
    let writer = state.writer.clone();
    let pi = Arc::clone(&state.pi);
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                    Ok(data) => {
                        if writer
                            .send(Envelope::event(stream_id.clone(), "pi.rpc", data))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) => {
                        if writer
                            .send(Envelope::event(
                                stream_id.clone(),
                                "pi.error",
                                json!({
                                    "message": format!("Pi stdout emitted invalid RPC JSON: {error}"),
                                }),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                },
                Ok(None) => break,
                Err(error) => {
                    let _ = writer
                        .send(Envelope::event(
                            stream_id.clone(),
                            "pi.error",
                            json!({ "message": error.to_string() }),
                        ))
                        .await;
                    break;
                }
            }
        }
        let process = pi.lock().await.remove(&stream_id);
        let exit_status = if let Some(process) = process {
            let PiProcess { mut child, stdin } = process;
            drop(stdin);
            match tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await {
                Ok(Ok(status)) => Some(status),
                Ok(Err(_)) => None,
                Err(_) => {
                    let _ = child.kill().await;
                    child.wait().await.ok()
                }
            }
        } else {
            None
        };
        let _ = writer
            .send(Envelope::event(
                stream_id,
                "pi.stdout_closed",
                json!({
                    "code": exit_status.as_ref().and_then(|status| status.code()),
                    "success": exit_status.as_ref().is_some_and(|status| status.success()),
                }),
            ))
            .await;
    });
    let stream_id = params.stream_id.clone();
    let writer = state.writer.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buffer = vec![0_u8; 4096];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => {
                    if writer
                        .send(Envelope::event_with_binary(
                            stream_id.clone(),
                            "pi.stderr",
                            Value::Null,
                            vec![buffer[..read].to_vec()],
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    Ok(json!({ "started": true }))
}

async fn pi_send(state: &ServerState, params: PiSendParams) -> Result<Value, String> {
    if !params.command.is_object() {
        return Err("Pi RPC command must be a JSON object".to_owned());
    }
    let stdin = {
        let processes = state.pi.lock().await;
        Arc::clone(
            &processes
                .get(&params.stream_id)
                .ok_or_else(|| format!("Pi stream '{}' is not running", params.stream_id))?
                .stdin,
        )
    };
    let mut bytes = serde_json::to_vec(&params.command).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BINARY_PAYLOAD_BYTES {
        return Err(format!(
            "Pi RPC command is {} bytes; pilo-server limit is {} bytes",
            bytes.len(),
            MAX_BINARY_PAYLOAD_BYTES
        ));
    }
    bytes.push(b'\n');
    let mut stdin = stdin.lock().await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        stdin.write_all(&bytes).await?;
        stdin.flush().await
    })
    .await
    .map_err(|_| format!("timed out while writing Pi stream '{}'", params.stream_id))?
    .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

async fn pi_stop(state: &ServerState, params: PiStopParams) -> Result<Value, String> {
    let Some(mut process) = state.pi.lock().await.remove(&params.stream_id) else {
        return Ok(Value::Null);
    };
    let _ = process.child.kill().await;
    let _ = process.child.wait().await;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bounded_output_discards_bytes_after_shared_limit() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let write_task = tokio::spawn(async move {
            writer.write_all(b"0123456789").await.unwrap();
        });
        let used = Arc::new(AtomicUsize::new(0));
        let overflowed = Arc::new(AtomicBool::new(false));
        let output = read_bounded_output(reader, Arc::clone(&used), Arc::clone(&overflowed), 4)
            .await
            .unwrap();
        write_task.await.unwrap();

        assert_eq!(output, b"0123");
        assert_eq!(used.load(Ordering::Acquire), 10);
        assert!(overflowed.load(Ordering::Acquire));
    }

    #[test]
    fn session_watcher_filters_to_jsonl_changes_in_target() {
        let target = PathBuf::from("sessions/workspace");
        let changed = Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
            .add_path(target.join("session.jsonl"));
        let unrelated = Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
            .add_path(PathBuf::from("sessions/other/session.jsonl"));
        let non_session = Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
            .add_path(target.join("notes.txt"));
        let access = Event::new(EventKind::Access(notify::event::AccessKind::Any))
            .add_path(target.join("session.jsonl"));

        assert!(is_session_change(&changed, &target));
        assert!(!is_session_change(&unrelated, &target));
        assert!(!is_session_change(&non_session, &target));
        assert!(!is_session_change(&access, &target));
    }

    #[cfg(unix)]
    #[test]
    fn remote_fs_does_not_follow_symlinks_outside_workspace() {
        use std::os::unix::fs::symlink;

        let unique = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "pilo-server-fs-test-{}-{unique}",
            std::process::id()
        ));
        let workspace = base.join("workspace");
        let outside = base.join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();
        symlink(&outside, workspace.join("escape")).unwrap();

        let workspace_text = workspace.to_string_lossy();
        assert!(checked_existing_path(&workspace_text, "escape/secret.txt", false).is_err());
        assert!(checked_mutation_path(&workspace_text, "escape/new.txt").is_err());

        let search = fs_search(FsSearchParams {
            workspace: workspace_text.into_owned(),
            query: "secret".to_owned(),
        })
        .unwrap();
        assert_eq!(search, json!([]));

        std::fs::remove_dir_all(base).unwrap();
    }
}
