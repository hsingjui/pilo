use std::{
    collections::HashMap,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex as StdMutex},
    time::UNIX_EPOCH,
};

use pilo_protocol::{
    CommandOutput, Envelope, EnvironmentInfo, FsEntry, FsEntryKind, PROTOCOL_VERSION, ServerHello,
    SessionFile, read_frame, write_frame,
};
use portable_pty::{Child as PtyChild, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, OnceCell, mpsc},
    task::JoinHandle,
};

pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

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
    pi: Arc<Mutex<HashMap<String, PiProcess>>>,
    session_watchers: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    terminals: Arc<StdMutex<HashMap<String, TerminalSession>>>,
    login_path: Arc<OnceCell<String>>,
    toolchain: Arc<OnceCell<ToolchainInfo>>,
}

struct PiProcess {
    child: Child,
    stdin: ChildStdin,
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
        let Envelope::Request { id, method, params } = message else {
            continue;
        };
        let state = state.clone();
        tokio::spawn(async move {
            let response = match dispatch(&state, &method, params).await {
                Ok(value) => Envelope::response(id, value),
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

async fn dispatch(state: &ServerState, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "hello" => to_value(ServerHello {
            protocol_version: PROTOCOL_VERSION,
            server_version: SERVER_VERSION.to_owned(),
            os: std::env::consts::OS.to_owned(),
            arch: std::env::consts::ARCH.to_owned(),
        }),
        "environment.inspect" => environment_inspect(state, from_params(params)?).await,
        "command.run" => command_run(state, from_params(params)?).await,
        "fs.read_dir" => fs_read_dir(from_params(params)?),
        "fs.read_file" => fs_read_file(from_params(params)?),
        "fs.write_file" => fs_write_file(from_params(params)?),
        "fs.stat" => fs_stat(from_params(params)?),
        "fs.mkdir" => fs_mkdir(from_params(params)?),
        "fs.mkdir_absolute" => fs_mkdir_absolute(from_params(params)?),
        "fs.rename" => fs_rename(from_params(params)?),
        "fs.remove" => fs_remove(from_params(params)?),
        "fs.search" => fs_search(from_params(params)?),
        "session.scan" => session_scan(from_params(params)?),
        "session.read" => session_read(from_params(params)?),
        "session.discover" => session_discover(),
        "session.watch_start" => session_watch_start(state, from_params(params)?).await,
        "session.watch_stop" => session_watch_stop(state, from_params(params)?).await,
        "preview.ports" => preview_ports().await,
        "terminal.open" => terminal_open(state, from_params(params)?).await,
        "terminal.write" => terminal_write(state, from_params(params)?),
        "terminal.resize" => terminal_resize(state, from_params(params)?),
        "terminal.close" => terminal_close(state, from_params(params)?),
        "pi.start" => pi_start(state, from_params(params)?).await,
        "pi.send" => pi_send(state, from_params(params)?).await,
        "pi.stop" => pi_stop(state, from_params(params)?).await,
        _ => Err(format!("unknown pilo-server method '{method}'")),
    }
}

fn from_params<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|error| error.to_string())
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

#[derive(Deserialize)]
struct WorkspaceParams {
    workspace: String,
}

#[derive(Deserialize)]
struct CommandParams {
    workspace: String,
    program: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    input: Vec<u8>,
}

async fn command_run(state: &ServerState, params: CommandParams) -> Result<Value, String> {
    let path = cached_login_path(state).await;
    let program = resolve_program(&path, &params.program);
    let mut command = process_command(&program, &params.args, &path);
    command
        .current_dir(&params.workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to run '{program}': {error}"))?;
    if !params.input.is_empty() {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "command stdin unavailable".to_owned())?;
        stdin
            .write_all(&params.input)
            .await
            .map_err(|error| error.to_string())?;
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| error.to_string())?;
    to_value(CommandOutput {
        code: output.status.code(),
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

async fn environment_inspect(
    state: &ServerState,
    params: WorkspaceParams,
) -> Result<Value, String> {
    let cwd = std::fs::canonicalize(&params.workspace).map_err(|error| {
        format!(
            "workspace '{}' is not accessible: {error}",
            params.workspace
        )
    })?;
    if !cwd.is_dir() {
        return Err(format!(
            "workspace '{}' is not a directory",
            params.workspace
        ));
    }
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
    let output = Command::new(shell)
        .args(["-ilc", &format!("printf '{MARKER}%s' \"$PATH\"")])
        .output()
        .await
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
    data: Vec<u8>,
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

fn checked_path(workspace: &str, relative: &str, allow_root: bool) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute() {
        return Err("path must stay inside the workspace".to_owned());
    }
    for component in relative.components() {
        if !matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        ) {
            return Err("path must stay inside the workspace".to_owned());
        }
    }
    if relative.as_os_str().is_empty() && !allow_root {
        return Err("workspace root is not valid for this operation".to_owned());
    }
    Ok(Path::new(workspace).join(relative))
}

fn fs_entry(workspace: &str, path: &Path) -> Result<FsEntry, String> {
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
            Path::new(workspace)
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
    let root = checked_path(&params.workspace, &params.path, true)?;
    let mut entries = std::fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .map(|entry| {
            let entry = entry.map_err(|error| error.to_string())?;
            fs_entry(&params.workspace, &entry.path())
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

fn fs_read_file(params: FsPathParams) -> Result<Value, String> {
    to_value(
        std::fs::read(checked_path(&params.workspace, &params.path, false)?)
            .map_err(|error| error.to_string())?,
    )
}
fn fs_write_file(params: FsWriteParams) -> Result<Value, String> {
    std::fs::write(
        checked_path(&params.workspace, &params.path, false)?,
        params.data,
    )
    .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}
fn fs_stat(params: FsPathParams) -> Result<Value, String> {
    to_value(fs_entry(
        &params.workspace,
        &checked_path(&params.workspace, &params.path, true)?,
    )?)
}
fn fs_mkdir(params: FsPathParams) -> Result<Value, String> {
    std::fs::create_dir_all(checked_path(&params.workspace, &params.path, false)?)
        .map_err(|error| error.to_string())?;
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
    std::fs::rename(
        checked_path(&params.workspace, &params.from, false)?,
        checked_path(&params.workspace, &params.to, false)?,
    )
    .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}
fn fs_remove(params: FsPathParams) -> Result<Value, String> {
    let path = checked_path(&params.workspace, &params.path, false)?;
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
            if path.is_dir() {
                if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist") {
                    continue;
                }
                visit(root, &path, query, result)?;
            } else if path.is_file() {
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
    let root = PathBuf::from(&params.workspace);
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
fn session_read(params: SessionReadParams) -> Result<Value, String> {
    let mut file = std::fs::File::open(&params.path).map_err(|error| error.to_string())?;
    use std::io::{Read as _, Seek as _, SeekFrom};
    file.seek(SeekFrom::Start(params.offset))
        .map_err(|error| error.to_string())?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)
        .map_err(|error| error.to_string())?;
    to_value(data)
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

fn session_fingerprint(workspace: &str) -> String {
    let Some(root) = agent_dir().map(|root| root.join("sessions").join(session_dir_key(workspace)))
    else {
        return "missing".to_owned();
    };
    let Ok(entries) = std::fs::read_dir(root) else {
        return "missing".to_owned();
    };
    let mut items = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let modified = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_nanos())
                .unwrap_or(0);
            Some(format!("{}:{}:{modified}", path.display(), metadata.len()))
        })
        .collect::<Vec<_>>();
    items.sort();
    items.join("|")
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
    let stream_id = params.stream_id.clone();
    let workspace = params.workspace;
    let writer = state.writer.clone();
    let task = tokio::spawn(async move {
        let _ = writer
            .send(Envelope::event(
                stream_id.clone(),
                "session.backend",
                json!({ "backend": "server-poll" }),
            ))
            .await;
        let mut previous = session_fingerprint(&workspace);
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let current = session_fingerprint(&workspace);
            if current != previous {
                previous = current;
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
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .await
            .map_err(|error| error.to_string())?;
        let ports = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u16>().ok())
            .collect::<Vec<_>>();
        return to_value(ports);
    }
    let script = "if command -v ss >/dev/null 2>&1; then ss -ltnH | awk '{a=$4; sub(/^.*:/,\"\",a); if(a ~ /^[0-9]+$/) print a}' | sort -nu; elif command -v netstat >/dev/null 2>&1; then netstat -lnt 2>/dev/null | awk 'NR>2 {a=$4; sub(/^.*:/,\"\",a); if(a ~ /^[0-9]+$/) print a}' | sort -nu; fi";
    let output = Command::new("/bin/sh")
        .args(["-c", script])
        .output()
        .await
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
    data: Vec<u8>,
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

    let stream_id = params.stream_id.clone();
    let event_stream_id = stream_id.clone();
    let event_writer = state.writer.clone();
    std::thread::Builder::new()
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
                            .blocking_send(Envelope::event(
                                event_stream_id.clone(),
                                "terminal.output",
                                json!({ "data": buffer[..read].to_vec() }),
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
        })
        .map_err(|error| format!("failed to start terminal reader: {error}"))?;

    state
        .terminals
        .lock()
        .map_err(|_| "terminal registry is poisoned".to_owned())?
        .insert(
            params.stream_id,
            TerminalSession {
                master: pair.master,
                writer,
                child,
            },
        );
    Ok(Value::Null)
}

fn terminal_write(state: &ServerState, params: TerminalWriteParams) -> Result<Value, String> {
    let mut terminals = state
        .terminals
        .lock()
        .map_err(|_| "terminal registry is poisoned".to_owned())?;
    let terminal = terminals
        .get_mut(&params.stream_id)
        .ok_or_else(|| format!("terminal '{}' is not running", params.stream_id))?;
    terminal
        .writer
        .write_all(&params.data)
        .and_then(|_| terminal.writer.flush())
        .map_err(|error| format!("failed to write terminal '{}': {error}", params.stream_id))?;
    Ok(Value::Null)
}

fn terminal_resize(state: &ServerState, params: TerminalResizeParams) -> Result<Value, String> {
    let terminals = state
        .terminals
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
        .map_err(|error| format!("failed to resize terminal '{}': {error}", params.stream_id))?;
    Ok(Value::Null)
}

fn terminal_close(state: &ServerState, params: TerminalCloseParams) -> Result<Value, String> {
    let Some(mut terminal) = state
        .terminals
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
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Pi stdin unavailable".to_owned())?;
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
                Ok(Some(line)) => {
                    let data = serde_json::from_str::<Value>(&line)
                        .unwrap_or_else(|_| json!({ "raw": line }));
                    if writer
                        .send(Envelope::event(stream_id.clone(), "pi.rpc", data))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
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
        pi.lock().await.remove(&stream_id);
        let _ = writer
            .send(Envelope::event(stream_id, "pi.stdout_closed", Value::Null))
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
                        .send(Envelope::event(
                            stream_id.clone(),
                            "pi.stderr",
                            json!({ "data": buffer[..read].to_vec() }),
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
    let mut processes = state.pi.lock().await;
    let process = processes
        .get_mut(&params.stream_id)
        .ok_or_else(|| format!("Pi stream '{}' is not running", params.stream_id))?;
    let mut bytes = serde_json::to_vec(&params.command).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    process
        .stdin
        .write_all(&bytes)
        .await
        .map_err(|error| error.to_string())?;
    process
        .stdin
        .flush()
        .await
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
